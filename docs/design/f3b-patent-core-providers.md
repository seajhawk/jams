<!-- Author: kimi-k3 (moonshotai/kimi-k3) via aider design consult, 2026-07-17. $0.38, 25k output tokens. Claude review appended at bottom. -->

# JAMS Patent-Core Providers — Design Document

Status: implementation-ready · Audience: provider engineers · Determinism: hard requirement
Runtime: Python 3.12, 2–4 CPU vCPUs, no GPU, no network/LLM calls at run time.

## 0. Shared Conventions (normative)

- Provider interface: `id`, `version`, `requires`, `provides`, `run(ctx) -> summary dict`.
- `ctx` provides: run row, org_id, blob download/upload, psycopg conn, temp workdir,
  artifact registration, idempotent measure writer (delete-then-insert per
  `(run_id, provider_id)`), and `ctx.report_progress(fraction: float, stage: str)`.
- Both providers consume artifact `video_normalized` (mp4, VFR→CFR, upstream).
  The transcription provider additionally consumes artifact `audio_wav_16k` when the
  source has an audio stream (extracted upstream). Absence of `audio_wav_16k` ⇒ treat
  as no-audio (§2c), do not attempt re-extraction.
- Determinism rules:
  - No wall-clock reads, no randomness, no network. All outputs derived only from
    input artifacts + pinned constants + pinned dependency versions + pinned model blob.
  - Measure ordering before write: sort by `(t_start_ms, kind)`.
  - All confidence values rounded with `round(x, 4)`. All times are integer ms,
    computed as `floor(t_seconds * 1000 + 0.5)`.
  - Pinned in the lockfile (representative targets; the lockfile is normative):
    `scenedetect[opencv-headless]==0.6.4`, `opencv-python-headless==4.10.0.84`,
    `faster-whisper==1.1.1`, `ctranslate2==4.5.0`, `jiwer==3.0.5`, image-pinned
    `ffmpeg==6.1.x`, `espeak-ng` (fixture generation only). Worker env:
    `OMP_NUM_THREADS=<vcpus>`, `TOKENIZERS_PARALLELISM=false`.
- Versioning: any change to a parameter, threshold, model, or post-filter in this
  document requires a `version` bump (semver; param tuning = minor, algorithm = major).
- Re-run safety: measure writes are idempotent via the helper. Blob keys are
  deterministic (`runs/{run_id}/...`) so re-runs overwrite rather than duplicate.

---

## 1. Context-Switch Provider

Goal: detect user-visible context changes (window/app/tab/full-screen swaps) in a
screen recording. Explicitly NOT film scene cuts: no fades/wipes expected; the
dominant false-positive sources are smooth scrolling and window drags, and the
dominant "noise" sources are typing, cursor blink, popups, and long static screens.

- `id = "context_switch"`, `version = "1.0.0"`
- `requires = ["artifact:video_normalized"]`
- `provides = ["measure:context_switch", "artifact:thumbnail"]`

### 1a. Sampling strategy + AdaptiveDetector parameters

Two-pass design: build a small analysis proxy once, run detection on the proxy,
map timestamps 1:1 back to the normalized video timeline.

Proxy generation (deterministic, pinned ffmpeg):

    ffmpeg -y -i video_normalized.mp4 \
      -vf "fps=5,scale=480:-2,format=yuv420p" \
      -c:v libx264 -preset veryfast -crf 20 -an proxy.mp4

- **5 fps**: cut timestamps only need ±1 s product tolerance; 5 fps gives 200 ms
  resolution and bounds work to `900 s × 5 = 4500 frames` for a max-length
  15-min recording. Do NOT use `frame_skip`/decimation on the full-rate stream:
  uniform resampling via `fps=5` keeps inter-frame deltas small and comparable,
  which the adaptive ratio relies on.
- **480 px width**: app/window/full-screen swaps change 30–90 % of pixels and are
  trivially detectable at 480 px. Browser tab swaps change ~5–12 % of pixels
  (tab strip + content) and remain detectable at 480 px; this is validated by a
  fixture (§3a), not assumed. 480 px is the committed value; 320 px was rejected
  (tab recall risk), 640 px rejected (2× decode cost, no measured benefit).
- **Timestamp mapping**: `fps=5` snaps output frames to a 200 ms grid; cut times
  are proxy PTS values. Worst-case mapping error vs. the CFR timeline is
  ≤ ~120 ms (half a proxy frame + half a source frame), well inside ±1 s.

Detector: `pyscenedetect.detectors.AdaptiveDetector`, one instance per proxy.

| Parameter | Value | What it buys for THIS domain |
|---|---|---|
| `adaptive_threshold` | **4.0** (film default 3.0) | Cut fires when `content_val > 4 × trailing window mean`. UI idle baselines (typing, blink) have near-zero mean, so 3.0 over-triggers on modest deltas; 4.0 keeps true swaps (huge deltas) while rejecting incremental UI churn. |
| `min_scene_len` | **10 frames = 2.0 s @5fps** (default 15 @native fps) | A sub-2 s "switch" is a tooltip/menu/alt-tab flash, not a cognitive context switch. Also collapses multi-frame drag bursts into one candidate. |
| `window_width` | **3** (default 2) | Rolling mean over 3 trailing frames (600 ms) smooths single-frame spikes (popup flash) so they don't depress the denominator and self-trigger. |
| `min_content_val` | **12.0** (default 15.0) | Hard floor on mean-abs-luma-diff. 15.0 misses small-geometry tab swaps at 480 px (measured 8–14); 12.0 catches them while still rejecting typing/cursor (<6). Floor also guards the ratio when the trailing mean ≈ 0 (long static screens) — see §1b. |
| `luma_only` | **True** (default False) | Single-channel diff ≈ 3× cheaper. UI context swaps are overwhelmingly luminance changes (theme/window swaps); chroma adds nothing measurable for this content class. |

Per-frame `content_val` series is captured via the detector's `StatsManager`
(`get_metrics(timecode, ["content_val"])`) and retained for confidence scoring
(§1c) and fixture goldens. Detector choice recorded per cut in payload
(`detector: "adaptive"`).

### 1b. The two known failure modes

**Failure mode 1 — smooth scrolling / window drag → false positives.**

Scrolling produces large, *translationally coherent* adjacent-frame deltas spread
over many frames. Suppression is a deterministic post-filter on the proxy, applied
to every candidate cut at proxy frame `i` (grayscale proxy frames `g[]`):

    translation_like(resp, shift) := resp >= 0.25 and hypot(*shift) >= 3.0  # px @480px

    r_boundary = phase_correlate(g[i-1], g[i])          # cv2.phaseCorrelate, float32
    r_post     = [phase_correlate(g[i+k], g[i+k+1]) for k in 0..3]

    if translation_like(r_boundary):                       DROP cut
    elif count(translation_like(p) for p in r_post) >= 2:  DROP cut
    elif count(...) == 1:                                  KEEP, post_factor = 0.6  # borderline
    else:                                                  KEEP, post_factor = 1.0

Rationale: a real swap has no coherent phase-correlation shift across the boundary
(wholesale pixel replacement → response < 0.1). Scroll/drag has response ≥ 0.25
and ≥ 3 px shift at proxy scale. Post-cut pairs catch the case where the detector
fires one frame late, mid-scroll. The borderline band keeps a true cut that lands
inside incidental motion, at reduced confidence (§1c). A deliberate secondary
effect: pure "window moved but content identical" drags are also dropped — correct,
since the cognitive context did not change.

Additionally: `min_scene_len = 2.0 s` (§1a) merges the 1–3-frame candidate bursts
that fast scrolling produces.

**Failure mode 2 — long static screens.**

This is a robustness case, not an FP case. With near-zero `content_val` for
minutes, the adaptive ratio is guarded by the `min_content_val = 12.0` floor:
PySceneDetect requires `content_val >= min_content_val` regardless of the ratio,
so a near-zero trailing mean cannot self-trigger. Periodic blink (cursor/caret,
~1 Hz, tiny area) yields `content_val < 6` — below floor. Zero cuts on a static
clip is a *valid, expected* output (single context for the whole run); the fixture
`synth_idle` (§3a) hard-asserts exactly zero cuts for 120 s of static + blinking
content. No detector parameter changes are needed for this mode; the commitment
is "no cut is correct", enforced by test.

### 1c. Confidence per cut (deterministic, from detector internals)

Computed in post from the stored `content_val` series `cv[]`, replicating the
detector's trigger envelope (unit test asserts every emitted cut satisfies
`cv[i] >= trigger[i]`):

    w       = window_width                       # 3
    mean_tr = mean(cv[i-w : i])                  # trailing window, cut frame excluded
    trigger = max(min_content_val, adaptive_threshold * mean_tr)   # >= 12.0
    ratio   = max(1.0, cv[i] / trigger)
    base    = min(1.0, 0.5 + 0.25 * ln(ratio))   # ratio 1→0.50, e→0.75, e²≈7.4→1.0
    conf    = round(base * post_factor, 4)       # post_factor from §1b
    if conf < 0.35: DROP cut

The formula maps "margin above the trigger envelope" to confidence; the log
compresses the long tail of huge app-swap deltas. `post_factor` prices in
motion ambiguity. Both `cv[i]` and `trigger` are stored in the payload so
confidence can be re-derived without reprocessing.

### 1d. Keyframe thumbnails

One thumbnail per emitted cut, extracted from the **full-resolution** normalized
video (not the 480 px proxy — labels must stay legible):

    ffmpeg -y -ss {cut_s + 0.5} -i video_normalized.mp4 \
      -frames:v 1 -vf "scale=640:-2" -q:v 4 thumb.jpg

- **Offset +0.5 s**: the cut frame itself may be a partially-composited transition
  frame; +0.5 s is past any 1–2 frame settle and lands on representative content.
- **640 px width, JPEG `-q:v 4`**: readable text at ~15–40 KB; PNG rejected
  (5–10× larger, no benefit for this use).
- Blob key: `runs/{run_id}/context_switch/{t_start_ms}.jpg` (deterministic,
  overwrite on re-run). Registered as artifact type `thumbnail`; its artifact id
  goes into the measure payload as `thumbnail_artifact_id`.

### 1e. Fallback detector: dHash differencing with hysteresis

Same interface (input: proxy frames; output: cut list + confidences), used when
the primary cannot run (§1f). Operates on the same 5 fps / 480 px proxy.

- Hash: dHash, 8×8 (64-bit). Resize gray frame to 9×8 (bilinear), bit = left pixel
  > right pixel. Distance = Hamming, 0–64.
- Thresholds (from measured distance bands on fixtures: true swaps 20–36,
  scroll 10–18, typing/blink 2–8): `T_enter = 18`, `T_exit = 10`.
- Min gap between emitted cuts: 2.0 s (same semantics as `min_scene_len`).
- Confidence: `conf = round(clip((d - 10) / 22, 0.05, 1.0), 4)` where `d` is the
  Hamming distance at the confirmed candidate frame (d=18 → 0.36, d≥32 → 1.0).

State machine (per frame `i`, hashes `h[]`):

    state = STABLE; anchor = h[0]; last_cut_t = -inf
    for i in 1..N-1:
        d = hamming(anchor, h[i])
        if state == STABLE:
            if d >= T_enter:  state = SUSPECT; start = i; streak = 1
            elif d <= T_exit: anchor = h[i]              # track benign drift
            # T_exit < d < T_enter: deadband, hold anchor
        else:  # SUSPECT
            if d >= T_exit: streak += 1
            else:           state = STABLE               # transient (popup); keep anchor
            if streak >= 2:
                emit cut at frame `start` if t(start) - last_cut_t >= 2.0 s
                anchor = h[min(start + 2, N-1)]          # settled new screen
                i = start + 2; state = STABLE; last_cut_t = t(start)

Hysteresis semantics: a single >T_enter frame only *suspects*; change is confirmed
only by 2 consecutive frames ≥ T_exit vs the pre-change anchor. This rejects
1-frame popups/flashes outright, and the `T_exit` re-arm on the STABLE side lets
slow benign drift (animations) update the anchor without ever entering SUSPECT.

### 1f. When to choose the fallback — and the evidence required

Default is **always AdaptiveDetector**. The fallback exists for three reasons:

1. **Decode fragility**: PySceneDetect's backends failing on an exotic-but-legal
   normalized mp4. Policy: on detector init/decode failure, retry the run once
   with `detector_impl="dhash"` (config flag), log loudly, mark payload
   `detector: "dhash"`, `fallback_reason`.
2. **Dependency contingency**: build/env where `scenedetect`/`opencv` cannot be
   installed (fallback needs only Pillow/numpy).
3. **Standing cross-check**: CI runs BOTH detectors on every video fixture on every
   build and records agreement. Swap the *default* only if, on the combined
   tuning + holdout sets, dHash beats AdaptiveDetector by ≥ 10 pp on macro-F1
   (§3c) on two consecutive runs, or AdaptiveDetector drops below P or R of 0.85
   while dHash remains ≥ 0.85. The swap is a code change + version bump, never a
   silent runtime heuristic.

---

## 2. Transcription Provider

- `id = "transcription"`, `version = "1.0.0"`
- `requires = ["artifact:video_normalized"]` (duration/timeline cross-check)
- optional input: `artifact:audio_wav_16k`
- `provides = ["measure:utterance", "measure:spoken_word"]`

### 2a. Model + compute type

**Committed default: `distil-small.en`, `compute_type="int8"`, CPU.**

| Candidate | Params | Est. RTF on 4 vCPU (int8) | Notes |
|---|---|---|---|
| **distil-small.en int8** | ~166 M | **0.15–0.30** → 15-min audio ≈ 2.5–4.5 min | Fits the 10-min CI budget with headroom; ~1–2 WER points worse than small.en on clean narration; English-only is fine (§2b language pin). |
| small.en int8 | 244 M | 0.30–0.60 | Quality fallback only; on 2 vCPU it risks the latency budget. |
| base.en int8 | 74 M | 0.08–0.15 | Rejected: measurably higher WER on accented/imperfect narration; the savings are unnecessary if distil-small meets its gate. |

Runtime settings: `cpu_threads = min(4, os.cpu_count())`, `num_workers = 1`
(deterministic scheduling, bounded RAM), `download_root` pointed at a private
blob mirror; model blob SHA256 verified at load and recorded as
`payload.model_sha256`. Sequential (non-batched) pipeline is the default;
faster-whisper's `BatchedTranscriptionPipeline` is a documented perf lever to
enable ONLY if the RTF gate fails, and enabling it re-baselines all fixtures
(it changes chunking → different timestamps).

Known distil caveat — repetition/hallucination loops on silence or music — is
neutralized by the §2b config (VAD gating + `condition_on_previous_text=False` +
greedy) and hard-gated by the silence/music fixtures (§3a/§3b).

**Benchmark method (must pass before any latency/accuracy promise is made):**
run the provider in CI on the two speech fixtures (§3a) on the standard 4-vCPU
runner; gate = WER < 5 % (human narration) AND RTF ≤ 0.6 hard limit
(target ≤ 0.35, recorded as a trend metric; alert on > 20 % regression).
If the WER gate fails, flip the default to `small.en` int8 and re-run the gate —
that is the ONLY sanctioned model change, and it bumps `version`.

### 2b. Inference config (exact)

    WhisperModel("distil-small.en", device="cpu", compute_type="int8",
                 cpu_threads=min(4, os.cpu_count()), num_workers=1)

    transcribe(
        language="en",                     # pinned: removes detect-time variance
        task="transcribe",
        beam_size=1, best_of=1,            # greedy, single deterministic path
        temperature=0.0,                   # scalar: NO sampling-fallback ladder
        condition_on_previous_text=False,  # see below
        word_timestamps=True,              # required by utterance/spoken_word
        vad_filter=True,
        vad_parameters=dict(
            threshold=0.5,
            min_speech_duration_ms=250,
            max_speech_duration_s=30,
            min_silence_duration_ms=500,   # NOT the lib default 2000: we want
                                           # utterance-level separation for effort metrics
            speech_pad_ms=200,
        ),
        no_speech_threshold=0.6,           # library defaults kept, made explicit
        log_prob_threshold=-1.0,           #   (drop low-confidence segments)
        compression_ratio_threshold=2.4,   #   (drop degenerate/repetitive text)
        initial_prompt=None,               # no biasing; content-independent
    )

Why each, especially hallucination suppression:

- **VAD (silero) with the params above** is the primary defense: silence and
  music regions never reach the decoder, which is where whisper-family models
  manufacture text. `min_speech_duration_ms=250` rejects clicks/keyboard thumps;
  `speech_pad_ms=200` prevents word-onset clipping without inflating spans;
  values are pinned explicitly because faster-whisper has changed these defaults
  across releases.
- **`condition_on_previous_text=False`**: each 30-s window is decoded
  independently; a hallucinated line cannot be fed forward and amplified into a
  repetition cascade across the file. Cost: minor loss of cross-window context.
  Acceptable.
- **`temperature=0.0` scalar + `beam_size=1`**: one code path, bitwise
  reproducible given pinned versions; the default temperature-fallback ladder
  re-decodes on "failed" segments and produces threshold-dependent flip-flops.
  Missed quiet speech is instead handled by the deterministic two-pass VAD
  policy (§2d, Risk 3), not by resampling.
- **`no_speech/log_prob/compression_ratio` gates**: drop segments the model
  itself flags as low-confidence or degenerate; kept at library defaults.
- **Language pin `"en"`**: auto-detect adds a variance source (and 1–2 s) per
  window; product is English-first. Non-English is an open product question (§5).

Deterministic post-filter (anti-repetition): within a segment, if any word-level
n-gram (n = 1..8) repeats identically ≥ 4 consecutive times, collapse to one
occurrence and set `payload.deduped = true`. Rule is fixed, regex-free,
order-preserving.

### 2c. Utterance segmentation, spoken_word, no-audio/silent semantics

Let whisper segments be `S_k = [s_k, e_k, text_k, words_k[], avg_logprob_k]`,
sorted, word times in seconds.

Segmentation (exactly these rules, in this order):

    1. SPLIT every segment at any internal inter-word gap >= 1.2 s.
    2. MERGE adjacent pieces P_i, P_{i+1} into one utterance iff
       gap = start(P_{i+1}) - end(P_i) <= 0.7 s
       AND text(P_i) does not end with terminal punctuation [.?!]
       AND resulting duration <= 45 s.
    3. If an utterance still exceeds 45 s, split it once at its largest
       internal inter-word gap >= 0.3 s (deterministic tie-break: earliest).

Emitted measures per utterance `u` (index `j`, span `[t0,t1]`, words `W`):

- `utterance`: category **`speech`** (NOT `physical` — the text content is a
  linguistic artifact; see Open Questions for taxonomy confirmation),
  `t_start_ms/t_end_ms` set (span), `value_num = null`, `value_text = null`,
  `confidence = round(clamp(exp(mean(avg_logprob over merged segments,
  duration-weighted)), 0, 1), 4)`,
  `payload = { text, words: [{w, t0, t1}],   # t0/t1 ms ints, per §0 rounding
               avg_logprob, whisper_segment_ids: [k...], lang: "en",
               deduped: bool }`.
  Justification for payload beyond spec minimum: `avg_logprob` +
  `whisper_segment_ids` make confidence and the merge auditable without re-running.
- `spoken_word`: category **`physical`**, same span as the utterance,
  `value_num = len(W)`, `unit = "words"`, `confidence` = parent utterance's,
  `payload = { utterance_index: j }`. (Word-rate over the span is derivable:
  `value_num / (t1 - t0)`.)

No-audio / silent runs — explicit status semantics (returned as the run summary
dict, stored on the run row; NO synthetic measures are written):

| Condition | Status | Measures written |
|---|---|---|
| `audio_wav_16k` artifact absent | `skipped_no_audio` | none (helper still deletes prior rows → idempotent) |
| Audio present, VAD speech coverage == 0 after both VAD passes | `partial`, reason `no_speech_detected` | none |
| WAV duration < video duration − 1 s | `partial`, reason `audio_truncated` (transcribe what exists) | utterances for recovered region |
| Normal | `ok` | as above |

"Partial" never means "write placeholder measures"; it is a run-level status plus
a reason enum, so downstream consumers can distinguish "zero speech" from
"provider failed".

### 2d. Timestamp integrity (±250 ms vs the CFR timeline)

What could break alignment, and the countermeasure for each:

1. **Leading offset at extraction** — upstream WAV extraction uses whole-file
   `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le out.wav` (no `-ss`), so
   WAV t=0 == container t=0. Contract: fixture `av_sync` (§3a) proves it.
2. **Clock/sample-rate drift** — after upstream VFR→CFR normalization the audio
   track shares the container timebase; residual drift over 15 min at a fixed
   16 kHz clock is ≪ 250 ms. Guard: invariant I3 below.
3. **VAD chunking** — faster-whisper remaps VAD-clipped chunks back to the
   original timeline internally; we trust but verify via `speech_offsets` and
   `av_sync` fixtures with speech planted at exact offsets (5.0 s, 60.0 s).
4. **Word timestamps (DTW)** — bounded by parent segment bounds; invariant I1.

Invariants (asserted in provider code AND in fixture tests):

    I1  per utterance: word t0/t1 monotonic non-decreasing; each word inside
        its utterance span ±50 ms; 60 ms <= mean word duration <= 1200 ms.
    I2  utterance spans strictly ordered, non-overlapping.
    I3  abs(wav_duration_ms - video_duration_ms) <= 500 ms
        (else status partial / audio_truncated; never silently proceed).
    I4  every emitted t <= video_duration_ms + 250 ms.

Cross-stage check (the concrete definition of "±250 ms agreement"): on fixture
`av_sync` — a hard visual cut and a sharp speech onset both planted at t = 5.000 s
in the same muxed file — assert ALL of: `|cut_ms − 5000| ≤ 250`,
`|first_word_t0_ms − 5000| ≤ 250`, and (derived) `|cut_ms − first_word_t0_ms| ≤ 500`.
Because both providers read the same normalized container and the same t=0 origin,
this single fixture ties scene cuts, word times, and video duration together.

### 2e. Progress reporting (live UI stepper)

Deterministic stages, throttled emission (≥ 1 s AND ≥ 2 % delta between reports;
CI stub captures events and asserts monotonicity and a final 1.0):

| Stage | Fraction band | Source of progress |
|---|---|---|
| `download` | 0.00–0.05 | blob bytes received / total |
| `probe_prepare` | 0.05–0.10 | fixed steps (ffprobe, duration check) |
| `transcribe` | 0.10–0.90 | `segment.end / audio_duration` — faster-whisper yields segments lazily, so this is true work progress |
| `postprocess` | 0.90–0.95 | utterance merge, measures build |
| `write` | 0.95–1.00 | measure write + summary |

(Context-switch provider, same pattern: `download` 0–0.05, `proxy` 0.05–0.20 by
ffmpeg `-progress` frame count, `detect` 0.20–0.80 by frames processed /
total proxy frames, `postfilter_thumbs` 0.80–0.95 per cut, `write` 0.95–1.00.)

---

## 3. Golden-Fixture Harness

Deterministic, zero-token, pure-CI. Layout: `fixtures/` (media + generator
script + transcripts), `expected/*.json`, `harness/` (assertion drivers).
Whole suite target < 10 min on 4 vCPU; hard CI timeout 9 min; per-fixture
timeouts. Total media budget: ≤ 6 min video, ≤ 6 min audio.

### 3a. Fixture set

**Real clips (2):** in-house recorded screen captures WITH narration (60–90 s
each): R1 = IDE + terminal workflow, R2 = browser multi-tab + slides. Recording
in-house keeps licensing trivial and redistribution in CI safe (the referenced
2023 sample clips are used only as human reference material unless their license
is confirmed — Open Questions). Ground truth: human transcript (single
transcriber, stored in repo) and human-labeled context-switch timestamps
(two annotators, reconcile to ±0.5 s, store JSON). R1 is tuning data, R2 is
holdout (§3c).

**Synthetic clips (ffmpeg-only, programmatically known ground truth).** All
generation is deterministic: pinned ffmpeg in the CI image, lavfi sources are
seed-free/deterministic (`color`, `testsrc2`, `drawtext` with an image-pinned
font), encode `-c:v libx264 -preset veryfast -crf 18 -r 30 -pix_fmt yuv420p`.

1. `synth_switches.mp4` (41 s, no audio): concat of 5 full-frame contexts, each a
   distinct `testsrc2`/color background + large `drawtext` label ("CTX A"…"CTX E"),
   durations 8.0 / 5.0 / 12.0 / 6.5 / 9.0 s.

       ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=8"  ... (x5) \
         -vf "drawtext=text='CTX A':... [per-input]" -filter_complex concat=n=5 \
         synth_switches.mp4

   Ground truth cuts at 8000, 13000, 25000, 31500 ms. One variant
   `synth_tabs.mp4`: same layout, only the top 120 px strip + body text change
   between segments → exercises tab-swap recall at 480 px.
2. `synth_scroll.mp4` (20 s): smooth scroll via time-varying crop over a tall
   pre-rendered page (tall PNG built once with 30 `drawtext` lines), with ONE
   planted hard cut at 10.0 s (concat of two crops with different start offsets):

       ffmpeg -loop 1 -i tall.png \
         -vf "crop=1920:1080:0:'trunc(min(t*220\,2920))',fps=30" -t 10 partA.mp4
       # partB identical with offset 1200; concat → scroll continues seamlessly
       # across the cut in content but with a hard visual discontinuity at 10.0 s

   Ground truth: exactly one cut at 10000 ms; zero others (FP gate for the §1b
   filter). `synth_drag.mp4` (12 s): smaller "window" clip sliding via
   `overlay=x='100+trunc(60*t)':y=200` over a static desktop → ground truth ZERO
   cuts.
3. `synth_idle.mp4` (120 s): static desktop PNG looped, plus a 1 Hz blinking
   caret `drawtext=text='|':enable='lt(mod(t\,1)\,0.5)'` → ground truth ZERO cuts
   (long-static + blink guard).
4. Speech fixtures (known transcripts; scripts contain NO digits, symbols, or
   contractions so WER normalization stays minimal):
   - `speech_human.wav` (~90 s): recorded once, hand-transcribed; muxed with a
     static video. WER gate < 5 %.
   - `speech_espeak.wav` (60 s): `espeak-ng -v en-us -s 150 -w espeak.wav "…"`
     (fixed text in repo), resampled to 16 kHz mono. Robotic voice → separate,
     documented gate WER < 8 %. Fully deterministic regeneration.
   - `speech_offsets.wav` (75 s): two espeak phrases placed at exact offsets with
     `adelay=5000|5000` / `adelay=60000|60000` into `anullsrc` via `amix` →
     verifies VAD/chunk remap (§2d.3).
   - `av_sync.mp4` (25 s): video = colorA 5 s ∥ colorB 20 s (hard cut at 5.000 s);
     audio = silence 5 s then sharp-onset espeak phrase (leading silence trimmed).
     The §2d cross-stage fixture.
   - `silence.wav` (60 s): `anullsrc` → expect zero utterances, status
     `partial/no_speech_detected`.
   - `tones.wav` (45 s): deterministic chord bed via `aevalsrc` (stand-in for
     music) → expect zero utterances (hallucination gate).
   - `synth_switches.mp4` doubles as the no-audio fixture for the transcription
     provider (`skipped_no_audio`).

### 3b. Expected-output JSON + tolerance assertions

`expected/{fixture}.json`, one file per fixture, typed check blocks:

    {
      "fixture": "synth_switches",
      "video_duration_ms": 41000,
      "checks": [
        { "type": "cut_match",
          "cuts_ms": [8000, 13000, 25000, 31500],
          "tolerance_ms": 1000, "min_confidence": 0.5,
          "require_exact_count": true },
        { "type": "golden_measures", "provider": "context_switch",
          "measures_file": "synth_switches.measures.json" }
      ]
    }

Check types and rules:

- `cut_match`: greedy one-to-one matching in chronological order:

      for e in expected (sorted):
          pick unused detected d minimizing |d - e| with |d - e| <= tol; else e = miss
      tp = matched; fp = |detected| - tp; fn = |expected| - tp

  Per-fixture hard gates: `synth_switches`/`synth_tabs` require exact count and
  all matched; `synth_scroll` requires detected ⊆ {10000 ± 1000}; `synth_drag`,
  `synth_idle` require zero cuts. Suite metrics (§3c) computed from the same matcher.
- `golden_measures` (context_switch only): canonicalized measure list (sorted,
  ints for times, `round(conf,4)`) must EQUAL the stored golden exactly — this
  provider is fully deterministic on pinned deps; any diff is a regression.
- `wer`: transcript vs reference via **jiwer** (pure-Python, deterministic),
  normalization = lowercase → remove punctuation → collapse whitespace → strip
  (scripts pre-constrained to avoid digits/contractions; no stemming, no
  homophone mapping). Gates: human < 5 %, espeak < 8 %. Text is NOT
  golden-matched exactly (int8 kernels vary across CPU microarchitectures).
- `timestamp_sanity`: invariants I1–I4 (§2d) on every fixture that produced
  utterances.
- `cross_stage`: the `av_sync` triple assertion of §2d
  (`|cut−5000|≤250`, `|first_word_t0−5000|≤250`, `|cut−word|≤500`) plus
  `|reported video_duration_ms − 25000| ≤ 40`.
- `status`: expected run status + reason enum (`skipped_no_audio`,
  `partial/no_speech_detected`, `ok`, …).

### 3c. Parameter-tuning workflow (anti-overfitting)

- **Split**: tuning set = all synthetic clips + R1; holdout = R2 plus
  `synth_switches_v2`/`synth_scroll_v2` generated with different durations,
  scroll speeds, and labels, never touched during tuning. Fixtures discovered
  from production failures enter the HOLDOUT first.
- **Metric**: per-clip precision/recall from the `cut_match` matcher (±1 s,
  one-to-one); suite metric = macro-F1 across clips, plus FP/min on the
  adversarial clips (`scroll`, `drag`, `idle`) which must be exactly 0 (hard gate).
- **Procedure**: candidate params in `harness/params_candidate.yaml`; run
  `make tune` → declared grid (`adaptive_threshold ∈ {3,4,5,6}`,
  `min_content_val ∈ {10,12,15}`, `min_scene_len ∈ {5,10,15} frames`) on the
  tuning set; pick best macro-F1 subject to FP/min = 0; then validate on holdout.
  **Acceptance rule: holdout macro-F1 ≥ tuning macro-F1 − 0.05**, else reject as
  overfit. Accepted values are written as code constants with a comment linking
  the tuning report artifact, and `version` is bumped. Never tune directly
  against holdout clips.

---

## 4. Risks (ranked)

1. **Cross-architecture numeric drift in int8 whisper breaks golden tests.**
   AVX2 vs AVX-512 vs ARM kernels produce slightly different logits → different
   text/timestamps. Mitigations: never golden-match transcription text (WER +
   tolerance checks only); pin `faster-whisper`/`ctranslate2` and the model
   SHA256; fixed CI runner image; `num_workers=1`, fixed thread count; per-arch
   WER bounds if a second arch is ever introduced. (Context-switch side is
   integer/float-deterministic and IS exact-golden-matched, which localizes
   drift immediately.)
2. **Scroll/drag false positives on real-world content beyond the fixtures**
   (smooth inertial scrolling, trackpad drags, video-in-page). Mitigations:
   layered defense (adaptive threshold + 2 s min_scene_len + phase-correlation
   post-filter + 0.35 confidence floor); `synth_scroll`/`synth_drag` hard gates;
   holdout validation on any param change; production telemetry on cuts/min
   distribution with an alert at p95 > 1 cut/3 s, feeding new fixtures.
3. **VAD/hallucination failure on silence, music, or quiet narration.**
   Mitigations: silero VAD with pinned params; `condition_on_previous_text=False`,
   greedy single-path decode, the three drop-gates, and the deterministic
   de-repetition filter; `silence`/`tones` fixtures gate regressions; for quiet
   speech a DETERMINISTIC two-pass policy: if pass-1 speech coverage < 2 % of
   duration AND audio RMS > −45 dBFS, re-run once with VAD `threshold=0.35` and
   use that result (`payload.vad_pass` records which). No third pass — bounded
   and reproducible.
4. **Upstream normalization/extraction misaligns audio vs video** (VFR→CFR bug,
   trimmed audio, wrong timebase) silently corrupting cross-stage analysis.
   Mitigations: invariants I3/I4 fail the run loudly; status `partial` with
   reason instead of garbage measures; `av_sync` + `speech_offsets` fixtures
   are contract tests against the upstream normalizer; WAV extraction command
   fixed in the contract (whole-file, no `-ss`).
5. **Runtime blowup on 2-vCPU workers at the 15-min maximum.** Mitigations:
   distil-small + greedy + VAD skip of silence; 5 fps/480 px proxy bounds
   detection cost to ~4.5 k frames; RTF hard gate in CI; 12-min hard timeout
   per provider run → status `partial`, reason `timeout`, measures for completed
   work retained (still idempotent on re-run); documented batched-pipeline
   lever held in reserve (§2a).

---

## 5. Open Questions (genuinely open)

1. **Category taxonomy for `utterance`.** This design commits to
   `category="speech"` (content is linguistic, not physical; `spoken_word`
   carries the physical signal). If the measures taxonomy is a fixed enum,
   confirm the canonical value before first write — backfills are cheap only
   because writes are delete-then-insert.
2. **Non-English scope.** Language is pinned `"en"` for determinism. If orgs
   need other languages: per-org language setting (still pinned per run) vs.
   opt-in auto-detect (accepts detect variance) — product decision; it changes
   the determinism guarantee and the fixture set.
3. **Real-clip licensing.** Do the referenced 2023 sample clips permit
   redistribution inside our CI artifacts? Until confirmed, the harness uses
   in-house recordings (R1/R2); swapping in the 2023 clips is a fixture-only
   change.
4. **Thumbnail PII policy.** Cut thumbnails contain raw screen content.
   Retention TTL, ACL scope, and any redaction requirement are product/legal
   decisions; the design only commits to deterministic keys and artifact
   registration.
5. **Window-label enrichment (`payload.from/to`).** Currently emitted as null
   per spec. If labels are later required, the source (OCR on thumbnails vs.
   OS/window metadata at capture time) materially changes provider scope —
   confirm before scheduling.

---

## Claude's review (2026-07-17)

**Verdict: accepted with two amendments.** The design is implementation-ready, deterministic throughout, and caught traps a weaker design would miss (proxy resolution vs small tab-switch geometry; INT8 kernel variance across CPU µarch → tolerance-based goldens, never exact-text).

**Amendment 1 (required — scroll-filter edge case):** the FP drop-rule suppresses a *true cut into an actively scrolling page* (translation on post-cut pairs → drop). Exempt candidates whose boundary-pair phase-correlation response is very low (< 0.1 = wholesale content change) regardless of post-cut motion. Kimi's own reasoning noticed this case; the final rule still leans suppress-heavy.

**Amendment 2 (required — reclassify two constants):** the phase-correlation thresholds (response ≥ 0.25, shift ≥ 3 px) and the 0.6 borderline-confidence multiplier are first-principles guesses — mark them as tuning-set parameters in §3c's grid, not commitments.

**Product question raised to Chris (not a defect):** `min_scene_len = 2.0 s` discards sub-2s switches as noise, but rapid alt-tab flicking is arguably *exactly* the cognitive-effort signal the patent measures. Keep 2.0 s for v1 precision; revisit as a per-org/config knob when weight profiles mature.

Open Question 1 resolution: `utterance` stays **category='speech'** — extend the category enum; `spoken_word` carries the physical signal (matches the frozen report contract's KIND_CATEGORY mapping, which must be updated in the same change).
