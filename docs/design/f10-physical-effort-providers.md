<!-- Author: kimi-k3 via aider design consult, 2026-07-18. $0.41, 27k tokens. Claude review appended at bottom. -->

# Physical-Effort Providers — Design Document (v1)

Status: PROPOSED. Scope: patent-core (JAMS) physical-effort measures —
clicks, keypresses, scrolls — from CFR-normalized screen recordings.
Author audience: implementers of the MeasureProvider pipeline.

## 0. Inputs, Contracts, Non-Goals

### Inputs relied upon
| Input | Contract assumed |
|---|---|
| Video | CFR mp4, ≤20 min, ≥1080p typical, 30 fps after normalization |
| Audio (optional) | 16 kHz mono WAV, aligned to video timeline within ±50 ms by the normalizer (ASSUMPTION — verify against the normalizer; A/V drift larger than this degrades click fusion) |
| VAD regions | Silero VAD speech intervals from the upstream transcript provider (`audio.transcript`), as `[start_ms, end_ms]` on the recording timeline |
| Proxy analysis pass | The existing context-switch provider decodes a 5 fps grayscale proxy and computes per-frame luma `content_val` and full-frame `cv2.phaseCorrelate` translation. **Assumed geometry: 480 px is the proxy WIDTH** (≈480×270 for 16:9), inferred from "cursor ≈6 px at 480p" (24 px cursor / 4× downscale). All px→percent math below uses measured proxy height `H_p`, so a wrong assumption here is contained to one constant. |
| ffmpeg | Pinned resolver, hard timeouts (existing) |

### Non-goals (v1, explicit)
- No cursor tracking. The cursor is ~6 px at proxy scale; reliable tracking across cursor themes at that size is not credible on this budget. We detect *UI responses* to clicks, not the cursor.
- No per-key identification, no modifier-combination detection, no right-click vs left-click, no double-click typing.
- No full-resolution decode in the hot path. Full-res patch analysis around candidates was evaluated and deferred (seek-decode cost from distant keyframes; benefit unproven). It is the first accuracy lever to revisit in v2.
- No LLM/API calls, no GPU, deterministic (fixed seeds everywhere; no wall-clock-dependent logic).

### Tuning-parameter convention
Constants marked **[TUNE]** are first-principles guesses, NOT commitments. Each ships in one
config module (`physical_effort_params.py`) with a comment stating its basis. Everything
unmarked is derived from the input contract (sample rates, frame rates, geometry).

---

## 1. Clicks

### 1a. Audio channel

**Method: band-limited spectral-flux onset detection with adaptive thresholding, followed by
temporal-context classification.** Mouse clicks are short (5–20 ms) broadband transients with
energy to 8 kHz; this favors flux on the 2–8 kHz band with fine time resolution over any
energy-envelope method (envelope methods smear the transient and lose to speech plosives).

Front-end (shared with keypresses via the `audio_onsets_v1` artifact, §5):
- Pre-emphasis high-pass: `y[n] = x[n] − 0.97·x[n−1]` (standard speech tilt compensation).
- STFT: Hann window 256 samples (16 ms), hop 64 (4 ms). 4 ms hop is derived: transient
  durations of 5–20 ms require ≤8 ms resolution.
- Onset strength `s(t)` = spectral flux (sum of positive log-magnitude deltas) over 2–8 kHz only.
  Restricting the band rejects keyboard body-thump and desk rumble (low) and voiced speech
  (dominated <2 kHz).
- Adaptive threshold: `thr(t) = median(s, ±1.5 s) + 4.0·MAD(s, ±1.5 s)` **[TUNE: 4.0]**,
  floored by a global `median(s) + 3.0·MAD(s)` so the threshold cannot collapse during long
  silence and start firing on noise.
- Peak picking: local maxima above `thr`, refractory 20 ms.
- Broadband gate: keep peaks with HF ratio `E(2–8k)/E(full) ≥ 0.35` **[TUNE]** — rejects thuds
  and low thumps.
- Merge pass: onsets <40 ms apart → keep the stronger **[TUNE: 40 ms]**. Merges switch
  press/release double-transients without eating real typing (40 ms = 25 keys/s, above any
  human rate).

Per-onset feature vector (12 dims, stored in the artifact): 4 band log-energies
(0–0.5k, 0.5–2k, 2–4k, 4–8k), 3 adjacent band ratios, spectral centroid, spectral flatness
(2–8k), HF ratio, decay-to-−20 dB time (ms, capped 60), flux peak height, crest factor.

**Click vs keystroke — the honest version:** a single mouse click and a single mechanical-key
press are acoustically near-identical. The reliable discriminator is **temporal context**:
typing arrives in trains; clicks are isolated or in pairs/triples. Spectral rules are a weak
second vote. Classification (runs once, in the artifact builder):


---

## Claude's review (2026-07-18)

**Verdict: accepted with three amendments.** Stronger than the F3-b draft — the [TUNE] discipline is self-applied throughout, the click/keystroke acoustic-confusion admission drives the architecture instead of being buried, the two-flash sync marker cleanly solves Playwright's untrustworthy timestamps, and the weight-0-until-real-precision graduation argument is exactly right for score trust. The speech-region policy (raised threshold + visual corroboration instead of blanket exclusion) is the single best product call in the doc.

**Amendment 1 (required):** clicks' `location{x,y}` from the UI-response centroid is NOT the click location — a click can trigger a change far from the cursor (button → panel opens elsewhere). Emit the centroid as payload field `response_centroid` (honest name); `location` stays null in v1.

**Amendment 2 (required):** silent recordings have zero keypress signal in v1 (no audio, text-churn corroboration deferred). The provider must record `skipped: no_audio` in provider_results and the report must not render "0 typing effort" as a finding — absence of signal, not absence of effort.

**Amendment 3 (spec precision):** the in-speech click recall gate (≥0.60) is only meaningful at a controlled mix SNR — pin the narrated fixtures' transient-to-speech ratio (−6 dB per §4b) as a stated constant of the gate.

Implementation order: F10-a fixture harness → F10-b scrolls (lowest risk, promotes the production-validated phase-correlation signal) → F10-c audio onsets artifact + keypresses + clicks.
