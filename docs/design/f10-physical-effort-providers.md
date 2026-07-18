<!-- Author: kimi-k3 via aider design consult, 2026-07-18. $0.41, 27k tokens. Claude review appended at bottom. -->

# JAMS Physical-Effort Providers - Design Document

## 0. Inputs, Contracts, Non-Goals



### Inputs relied upon

| Input | Contract assumed |

|---|---|

| Video | CFR mp4, ≤20 min, ≥1080p typical, 30 fps after normalization |

| Audio (optional) | 16 kHz mono WAV, aligned to video timeline within ±50 ms 
by the normalizer (ASSUMPTION — verify against the normalizer; A/V drift larger
than this degrades click fusion) |

| VAD regions | Silero VAD speech intervals from the upstream transcript 
provider (`audio.transcript`), as `[start_ms, end_ms]` on the recording 
timeline |

| Proxy analysis pass | The existing context-switch provider decodes a 5 fps 
grayscale proxy and computes per-frame luma `content_val` and full-frame 
`cv2.phaseCorrelate` translation. **Assumed geometry: 480 px is the proxy 
WIDTH** (≈480×270 for 16:9), inferred from "cursor ≈6 px at 480p" (24 px cursor
/ 4× downscale). All px→percent math below uses measured proxy height `H_p`, so
a wrong assumption here is contained to one constant. |

| ffmpeg | Pinned resolver, hard timeouts (existing) |



### Non-goals (v1, explicit)

- No cursor tracking. The cursor is ~6 px at proxy scale; reliable tracking 
across cursor themes at that size is not credible on this budget. We detect *UI
responses* to clicks, not the cursor.

- No per-key identification, no modifier-combination detection, no right-click 
vs left-click, no double-click typing.

- No full-resolution decode in the hot path. Full-res patch analysis around 
candidates was evaluated and deferred (seek-decode cost from distant keyframes;
benefit unproven). It is the first accuracy lever to revisit in v2.

- No LLM/API calls, no GPU, deterministic (fixed seeds everywhere; no 
wall-clock-dependent logic).



### Tuning-parameter convention

Constants marked **[TUNE]** are first-principles guesses, NOT commitments. Each
ships in one

config module (`physical_effort_params.py`) with a comment stating its basis. 
Everything

unmarked is derived from the input contract (sample rates, frame rates, 
geometry).



---



## 1. Clicks



### 1a. Audio channel



**Method: band-limited spectral-flux onset detection with adaptive 
thresholding, followed by

temporal-context classification.** Mouse clicks are short (5–20 ms) broadband 
transients with

energy to 8 kHz; this favors flux on the 2–8 kHz band with fine time resolution
over any

energy-envelope method (envelope methods smear the transient and lose to speech
plosives).



Front-end (shared with keypresses via the `audio_onsets_v1` artifact, §5):

- Pre-emphasis high-pass: `y[n] = x[n] − 0.97·x[n−1]` (standard speech tilt 
compensation).

- STFT: Hann window 256 samples (16 ms), hop 64 (4 ms). 4 ms hop is derived: 
transient

  durations of 5–20 ms require ≤8 ms resolution.

- Onset strength `s(t)` = spectral flux (sum of positive log-magnitude deltas) 
over 2–8 kHz only.

  Restricting the band rejects keyboard body-thump and desk rumble (low) and 
voiced speech

  (dominated <2 kHz).

- Adaptive threshold: `thr(t) = median(s, ±1.5 s) + 4.0·MAD(s, ±1.5 s)` 
**[TUNE: 4.0]**,

  floored by a global `median(s) + 3.0·MAD(s)` so the threshold cannot collapse
during long

  silence and start firing on noise.

- Peak picking: local maxima above `thr`, refractory 20 ms.

- Broadband gate: keep peaks with HF ratio `E(2–8k)/E(full) ≥ 0.35` **[TUNE]** 
— rejects thuds

  and low thumps.

- Merge pass: onsets <40 ms apart → keep the stronger **[TUNE: 40 ms]**. Merges
switch

  press/release double-transients without eating real typing (40 ms = 25 
keys/s, above any

  human rate).



Per-onset feature vector (12 dims, stored in the artifact): 4 band log-energies

(0–0.5k, 0.5–2k, 2–4k, 4–8k), 3 adjacent band ratios, spectral centroid, 
spectral flatness

(2–8k), HF ratio, decay-to-−20 dB time (ms, capped 60), flux peak height, crest
factor.



**Click vs keystroke — the honest version:** a single mouse click and a single 
mechanical-key

press are acoustically near-identical. The reliable discriminator is **temporal
context**:

typing arrives in trains; clicks are isolated or in pairs/triples. Spectral 
rules are a weak

second vote. Classification (runs once, in the artifact builder):



```
trains = group_onsets(onsets, max_gap = 600 ms)

for tr in trains:

    if |tr| >= 4 and 70 <= mean_ioi(tr) <= 500 ms

       and cv(ioi(tr)) <= 0.55              # [TUNE]

       and spec_selfsim(tr) >= 0.70:        # mean pairwise cosine sim of onset
spectra [TUNE]

        label(tr, 'typing')

for onset not in any typing train:

    if decay <= 25 ms and centroid >= 3.0 kHz:  # [TUNE both]

        label 'click_candidate'              # mouse-leaning

    else:

        label 'ambiguous'                    # could be click or isolated key

```


**Mouth sounds:** lip/tongue clicks land mostly inside VAD speech regions and 
are handled by

the speech policy below. Mouth clicks in inter-sentence pauses survive and look
like

`ambiguous` onsets — visual corroboration is the only defense, and a residual 
false-positive

rate on narrated content is accepted (priced into §1d).



**Speech-region policy (refines blanket exclusion):**

- Pad VAD regions by ±120 ms **[TUNE]** (VAD edges clip plosive onsets).

- Outside speech: normal threshold.

- Inside speech: threshold ×1.6 **[TUNE]** AND the candidate is marked 
`requires_visual` —

  it can only be emitted if visually corroborated. Rationale: blanket exclusion
throws away

  every click the user makes while narrating, which in narrated demos is a 
large fraction of

  real clicks. A pure-exclusion fallback (`speech_policy = 'exclude'`) remains 
in config if

  validation shows the in-speech FP rate is intolerable.



**CPU:** vectorized STFT + flux over 20 min @16 kHz ≈ 300k hops × 256-pt FFT: 
**<10 s** on

2 vCPU with scipy/numpy. Negligible.



### 1b. Visual channel



What is realistic at 5 fps / 480×270 grayscale:

- **Not realistic:** cursor tracking (6 px, theme variants, grayscale), 
template matching

  across cursor variants, detecting button-depress animations (they complete 
between frames).

- **Realistic:** per-frame change masks and the 
*stationary-then-localized-delta* pattern: a

  click on UI chrome follows a quiet period (cursor settled on target) and 
triggers a

  localized, spatially stable change (button state, menu open, field focus, 
navigation start)

  within 0–400 ms.



Design: **audio proposes, vision verifies** (verification is cheap and 
localized in time);

vision proposes only when there is no audio track.



Per-frame data already in the shared artifact: `diff_energy` (mean |Δ| over the
interior

region [8%..92%] of height, excluding browser chrome) — added to the existing 
proxy pass.



`verify_visual(t)` on the proxy:

```
pre_quiet : mean(diff_energy[t-600ms .. t-200ms]) <= P60(diff_energy over 
recording)   # [TUNE: P60]

mask_k    : |frame(k) - frame(k-1)| > 25 gray levels, for k in the 2 frames 
after t    # [TUNE: 25]

post_delta: exists k with 0.002 <= area(mask_k) <= 0.30                        
# [TUNE both]

            and |centroid(mask_1) - centroid(mask_2)| <= 0.05 * W_proxy        
# [TUNE]

return (pre_quiet and post_delta), location = upscale(centroid(first 
significant mask_k))

```
- Area bounds reject both sub-perceptual changes and scene cuts/scrolls (>30% 
of frame is a

  cut/scroll, not a click response — cross-checked against the scroll/cut 
signals in the

  same artifact).

- **Location semantics, honestly:** the emitted location is the centroid of the
*UI response*,

  upscaled to full-res coordinates — usually the clicked button, but a centered
dialog shifts

  it. Expect ±40 px typical error, worse for non-local responses. It is emitted
only when

  visual verification passes; otherwise `location: null`.



Visual-propose mode (only when the recording has **no audio track**): scan all 
frames for the

quiet→localized-delta pattern using connected components on change masks (6000 
frames ×

0.13 MP ≈ 15–25 s CPU, capped at 4000 candidates **[TUNE]**). Emitted at fixed 
low

confidence (§1c). When audio exists, visual-only proposals are **suppressed** 
(see argument

below).



### 1c. Fusion and confidence tiers



| Evidence | Confidence |

|---|---|

| `click_candidate`, outside speech, visually corroborated | 0.90 |

| `click_candidate`, outside speech only | 0.70 |

| any audio candidate, inside speech, visually corroborated | 0.60 |

| `ambiguous`, outside speech, visually corroborated | 0.55 |

| `ambiguous`, outside speech only | 0.40 |

| visual-only proposal, no audio track exists | 0.35 |

| audio candidate inside speech, not corroborated | 0.30 → suppressed |

| visual-only proposal while audio track exists | 0.20 → suppressed |



All tier values are **[TUNE]**; the ordering is the design, the numbers are 
priors.



**Emit-vs-suppress argument:** the measures table carries `confidence`, so 
emitting weak rows

is technically safe — but these rows feed patent claims, and a row that is more
likely wrong

than right is noise even when confidence-weighted. Suppression threshold: 
**0.35** (everything

at or below ~1/3 expected precision is dropped). Visual-only-with-audio is 
suppressed outright:

when a working audio channel captured no transient, a "click-like" visual event
is almost

always a hover animation, autoplay, or a scroll side-effect — emitting it 
systematically

converts other providers' events into click false positives. Silent-mouse 
hardware is the

accepted casualty.



### 1d. Expected accuracy (priors, to be validated — §4 fixtures + §5 
graduation)



| Scenario | Channel | Precision | Recall |

|---|---|---|---|

| Narrated | audio (in+out of speech) | 0.75–0.85 | 0.40–0.60 |

| Narrated | fused | **0.85–0.90** | **0.40–0.55** |

| Audio, no speech | audio | 0.80–0.90 | 0.75–0.90 |

| Audio, no speech | fused | **0.85–0.92** | **0.70–0.85** |

| No audio track | visual-only | 0.35–0.50 | 0.35–0.50 |



Recall on narrated recordings is the weak point and there is no cheap fix: 
clicks made during

speech are physically masked. We say so in the measures documentation rather 
than inflating

confidence.



---



## 2. Keypresses



**Framing: this is a burst detector and count estimator, not a per-key 
detector.** The patent

payload (`type, count, keys?`) is satisfied with `type:'multiple'`, an 
estimated `count`, and

`keys: null`. Confidence must be read as "confidence in the burst and its 
approximate count",

never "we observed exactly N keys".



**Burst detection** — from the labeled `audio_onsets_v1` artifact (§1a):

- Burst = a maximal `typing` train; split when an inter-onset gap ≥ **800 ms** 
**[TUNE]**

  (pause = thinking, not typing).

- Press/release double-counting: key release produces a second transient 50–120
ms after

  press, overlapping fast-typing IOIs. Detector (conservative, fires only on 
strong evidence):

  ```

  ioi = diffs(burst_onset_times)

  if fraction(ioi <= 90 ms) >= 0.40                       # [TUNE]

     and pair_spec_sim(even_idx_onsets, odd_idx_onsets) >= 0.80:  # [TUNE]

      collapse alternate onsets; count = ceil(n/2); set count_merged = true

  ```

  When it misfires on genuinely fast typing it undercounts by up to 2× on that 
burst — known

  failure mode, penalized in confidence (−0.15), revisit after fixture data.

- Count = number of onsets in the burst after merging. **Expected count error: 
±10% on clean

  audio, ±25% under speech overlap; systematic undercount above ~10 keys/s** 
(onset overlap).

  This is conveyed via confidence, and documented on the provider; the payload 
has no

  error-interval field and we do not invent one in v1.



**Visual corroboration (in v1, deliberately the cheap version):** typing makes 
text appear —

small localized churn synchronized with keystrokes. Using artifact 
`diff_energy` only (no new

decode): a burst is `corroborated` if ≥50% of its onsets have a `diff_energy` 
local peak

within ±250 ms **[TUNE both]**. Cost: seconds. It disambiguates typing trains 
from percussive

ambient noise, which is its entire job; richer text-region analysis is v2.



**Confidence per burst:** base 0.55; +0.15 if `spec_selfsim ≥ 0.80`; +0.15 if 
visually

corroborated; +0.10 if the whole burst lies outside speech; −0.15 if 
`count_merged`; clamp

[0.30, 0.90]. All coefficients **[TUNE]**. Suppress bursts below 0.35 (same 
trust argument as

clicks).



**Emitted row:** `t_start = first_onset − 30 ms`, `t_end = last_onset + 80 ms`,

`value_num = count`, `unit = 'keys'`, payload `{type:'multiple', count, 
keys:null}`.



**v1 exclusions (explicit):** no `type:'single'` (isolated key transients are 
acoustically

indistinguishable from clicks — emitting them would poison both kinds; a 
per-recording

spectral clustering of transients into mouse/keyboard clusters, k-means k=2 
with fixed seed,

is the planned v1.1 unlock), no `type:'combination'`.



**Silent recordings:** no keypress rows, at all, in v1. Estimating keystroke 
counts from

proxy-resolution text churn is not credible; we prefer an honest absence over a
fabricated

count. Documented as a known coverage gap.



---



## 3. Scrolls



### Promotion of the existing signal — shared artifact, not a new pass



The context-switch provider's rejected "translation-like" candidates are the 
scroll signal.

We refactor its analysis pass into a cached artifact, **`proxy_motion_v1`**, 
built once per

video (build-if-missing, atomic tmp+rename, keyed by `{video_hash, 
builder_version}`):



```
proxy_motion_v1.npz:

  fps=5, frame_ms:int32[N], W, H,

  content_val:f32[N]                    # existing luma signal (context-switch 
keeps using it)

  dx_full, dy_full, resp_full:f32[N]    # existing full-frame phaseCorrelate 
output

  strip_dy:f32[3,N], strip_dx:f32[3,N], strip_resp:f32[3,N]   # NEW: 3 
horizontal strips

  diff_energy:f32[N]                    # NEW: mean |Δ| over interior region

```


The context-switch provider is refactored to *consume* this artifact (its 
suppression logic

is unchanged — it still rejects translation-like windows from scene-change 
measures; the

scroll provider now claims those same windows as a *different kind*, so there 
is no

double-counting in the measures table). If the pipeline scheduler supports 
artifact

dependencies, the builder runs first; otherwise each consumer 
builds-if-missing. No second

decode pass is added anywhere.



**Why strips:** a real page scroll translates content but not fixed chrome or 
sticky

headers, so a single full-frame correlation systematically underestimates and 
occasionally

rejects real scrolls; an embedded video translates one region while the page is
still.

Strips = 3 horizontal thirds of the interior [8%..92%] height band. Robust 
per-frame motion:

```
agree(i): >= 2 of 3 strips have same-sign dy within 1.5 px of 
median(strip_dy[:,i])   # [TUNE: 1.5]

valid_scroll_frame(i): agree(i) and median(strip_resp[:,i]) >= 0.15            
# [TUNE: 0.15]

                       and |median(strip_dy[:,i])| >= 1.5 px                   
# [TUNE: 1.5]

```
`agree` also *is* the embedded-video/parallax rejection: local motion fails the
2-of-3 test.

Added cost ≈ 18k small phaseCorrelates ≈ **15 s** per 20-min video; if budget 
tightens,

compute strips only for frames where `resp_full < 0.15` or `|dy_full| ≥ 1.0` px
(config flag,

est. −70%).



### Event assembly



```
runs = maximal runs of valid_scroll_frame with consistent sign(dy),

       bridging single invalid frames

split runs at: scene cuts (content_val drop, same rule context-switch uses — 
read from

               the artifact, so no ordering dependency),

               invalid gaps >= 3 frames (600 ms),                       # 
[TUNE]

               sign-reversal runs >= 2 frames

drop single-frame runs with |dy| < 8 px                                 # flick
threshold [TUNE]

```


**Emitted row per event:** `t_start = frame_ms[first]`, `t_end = frame_ms[last]
+ 200 ms`,

`type = 'vertical'` if Σ|dy| ≥ 2·Σ|dx| else `'horizontal'`,

`percent = round(100 · Σ|dy| / H_proxy, 1)`, `value_num = percent`,

`unit = 'percent_viewport'`. `percent` is total distance traversed as % of 
viewport and can

exceed 100 — this is the patent's contextual distance and is well-defined from 
pixels.

**`lines: null` in v1**: line height at proxy scale (≈6–11 px) is not 
measurable reliably;

a guessed integer risks patent misinterpretation, which is worse than null. 
Non-patent

extension field `direction` (`up|down|left|right`) is included in payload jsonb
— free

information, harmless to the patent shape.



Inertial/momentum scrolls emerge naturally as decaying multi-frame runs. Two 
wheel-scrolls

separated by ≥600 ms of stillness become two events — matching the patent's 
event semantics.



**Confidence:** 0.85 multi-frame event with clean dominance; 0.70 single-frame 
flick;

−0.10 if strips disagreed anywhere inside the event. **[TUNE levels]**



**Expected accuracy:** page-scroll recall 0.85–0.95, precision 0.85–0.92, 
percent error

±10–15% relative. Parallax underestimates (median tracks the dominant layer). 
Map/canvas

drags are detected as scrolls — accepted as effort-adjacent, noted in docs.



### Zoom



Feasible on CPU as a **capped fallback classifier**, not a continuous search. 
Frames with

high `diff_energy` but no valid translation and no scene cut (i.e., the 
context-switch

provider's *unexplained* rejected windows) get a coarse scale search: 
phaseCorrelate of the

frame pair after rescaling the later frame by {0.85, 0.90, 0.95, 1.05, 1.11, 
1.18}

**[TUNE set]**; accept if a non-identity scale wins with `resp ≥ 0.25` and ≥30%
above the

identity response **[TUNE both]**. Cap: 300 candidate windows per recording 
**[TUNE]** —

cost ≤ ~3 s. Zoom events aggregate like scrolls; `percent = (scale−1)·100` 
signed

(positive = in), `direction: 'in'|'out'`. Confidence 0.60. If validation shows 
pinch-zoom is

rare in real footage, this is the first feature to cut — it is isolated behind 
one flag.



---



## 4. Fixture Harness



Ground truth without humans, in three families. **Audio-only and video fixtures
are

separate**; fusion is tested by a third, muxed family. All generators are 
seeded and pinned;

tolerances live in one `tolerances.json` so every assertion's slack is explicit
and auditable.



### 4a. Video fixtures (Playwright) — exercise scroll + visual-click paths



- Generator: pinned Playwright + Chromium in a pinned container. `viewport 
1920×1080`,

  `deviceScaleFactor: 1`, bundled fixed font (no system fonts), static local 
HTML pages

  (long fixed-`line-height` text page for scrolls; button grid with `:active` 
state changes

  and counters for clicks; one page with hover-only animations as a negative), 
no autoplaying

  media except in designated negative fixtures.

- `recordVideo` at 1920×1080 (Playwright emits video-only WebM with irregular 
screencast

  timing — **container timestamps are not trusted for anything**), then 
normalized with the

  production ffmpeg command to CFR 30 mp4, so fixtures exercise the real input 
path.

- Ground truth: `page.addInitScript` installs `mousedown`/`keydown` listeners 
capturing

  `event.timeStamp` (page clock = truth) into `window.__events`, dumped to 
JSONL after the

  session. Scrolls use logged `window.scrollBy` calls with known pixel 
distances; typing uses

  `page.keyboard.type` into an input (per-key timestamps from the listener, 
text-churn

  corroboration included). Sessions mix `instant` and CSS-smooth scrolls to 
test aggregation.



**The alignment problem — solved with a two-flash visual sync marker + drift 
correction:**

the page starts black; at page-clock 1000 ms it shows a full-white frame for 
300 ms; a second

identical flash fires at session end. The flashes are detectable in the decoded
video

independent of container metadata:

```
flashes = maximal runs of frames with mean_luma >= 245, length >= 2 frames

assert len(flashes) == 2                       # else fixture is invalid, fail 
loudly

offset = t_video(flash1) - t_log(flash1)

drift  = (t_video(flash2) - t_log(flash2)) - offset

assert |drift| <= 200 ms                       # CFR conversion health check 
[TUNE]

t_video = t_log + offset                       # or a least-squares linear map 
on the

                                               # two flash pairs if |drift| > 
50 ms [TUNE]

```
Headless-rendering nondeterminism (screencast frame scheduling, SwiftShader 
rasterization)

is absorbed by the flash sync plus the tolerances below — we never assert on 
container

timestamps or exact frame indices.



### 4b. Audio fixtures (synthesis) — exercise click/key audio paths in 
isolation



- Python/numpy writes 16 kHz mono WAV directly; paired with a generated static 
black video of

  matching duration so providers run end-to-end (this simultaneously asserts 
the visual path

  emits nothing on static content).

- Transient recipes (first-principles, fixed seed): click = 2.5 ms shaped noise
burst, 8 ms

  exponential decay, band-passed 1.5–8 kHz; keystroke = 4 ms burst with lower 
centroid plus a

  100 Hz, 30 ms body thump. Amplitudes jittered over a seeded range. Mixed at 
exactly known

  offsets onto a −60 dB dither floor.

- Narrated variants: espeak-ng (pinned version) rendering a fixed transcript, 
mixed at −6 dB

  relative. The WAV is then run through the **real upstream providers** 
(faster-whisper +

  Silero VAD) so fixtures consume the same VAD/transcript artifacts production 
provides —

  espeak output is intelligible and whisper handles it.

- Negative fixtures: 5 min pure speech → expect 0 click rows, 0 keypress rows. 
Music bed →

  0 rows.



### 4c. Integration fixtures (fusion)



Playwright video + synthesized audio muxed with pinned ffmpeg at a known 0 ms 
offset. One

variant with audio delayed +300 ms as a robustness probe (expected: graceful 
confidence

degradation, not crashes).



### 4d. Assertions and tolerances



| Fixture family | Assertion | Tolerance |

|---|---|---|

| Audio clicks, no speech | count exact; per-event timestamp | ±75 ms |

| Audio clicks, speech overlap | recall ≥ 0.60, precision ≥ 0.85; matched 
timestamps | ±75 ms |

| Audio keys | burst count exact; per-burst count exact at ≤8 keys/s, ±1 above;
burst edges | ±150 ms |

| Negative audio | 0 click rows, 0 keypress rows | exact |

| Video scrolls | event count exact (scrolls separated ≥1.0 s); percent; 
direction; edges | ±12% relative; ±300 ms |

| Video zoom | percent | ±20% relative |

| Video clicks (visual path) | recall ≥ 0.70, precision ≥ 0.70; timestamps; 
location when emitted | ±400 ms; ≤80 px full-res |

| Alignment | drift | ≤200 ms |



**Honesty note:** synthetic fixtures validate plumbing, math, and 
classification logic —

they systematically *overstate* real-world accuracy (clean transients, 
deterministic

rendering). Fixture metrics are labeled `synthetic` wherever reported, and §5's
graduation

criteria explicitly require real-footage validation before any Effort-Score 
weight enables.



---



## 5. Provider Architecture



**Three providers, not one.** Separate ids/versions give independent idempotent

delete-then-insert scopes and failure domains — a crash in click audio analysis
must not cost

the scroll measures, which rest on an already-production-validated signal. 
Shared work lives

in cached artifacts, not in a shared provider.



| provider_id | version | requires | provides / emits |

|---|---|---|---|

| `physical.scrolls` | 1.0.0 | artifact `proxy_motion_v1` (build-if-missing) | 
`scrolls` rows |

| `physical.keypresses` | 1.0.0 | audio track present; artifacts 
`audio_onsets_v1`, `proxy_motion_v1`; VAD from `audio.transcript`; no-ops 
cleanly without audio | `keypresses` rows |

| `physical.clicks` | 1.0.0 | artifact `proxy_motion_v1`; optionally 
`audio_onsets_v1` + VAD; visual-only mode when no audio | `clicks` rows |



`audio_onsets_v1.json` schema: `{builder_version, noise_floor stats, 
onsets:[{t_ms,

feats[12], label: typing|click_candidate|ambiguous, train_id, in_speech}]}`. 
Train

classification lives in the artifact builder, so `physical.keypresses` and 
`physical.clicks`

have no ordering dependency on each other.



**Execution order:** `audio.transcript` (existing, provides VAD) → 
`video.context_switch`

(existing; builds `proxy_motion_v1` if absent) → `physical.scrolls` → 
`physical.keypresses`

→ `physical.clicks`. Adjacency of scrolls to context-switch is deliberate: same
artifact,

same mental model, one operational unit.



**Payload commitments (v1):**



| kind | fields committed | null in v1 |

|---|---|---|

| clicks | `{type:'single'}` always; `location{x,y}` **iff** visual 
verification passed (UI-response centroid, upscaled, ±40 px honesty note in 
docs); `t_end` null (point event); `value_num=1`, `unit='click'` | `context` |

| keypresses | `{type:'multiple', count}` per burst; `t_start/t_end` span the 
burst; `value_num=count`, `unit='keys'` | `keys`; `single` and `combination` 
types not emitted |

| scrolls | `{type: vertical|horizontal|zoom, percent}`; `t_start/t_end` span; 
`value_num=percent`, `unit='percent_viewport'`; extension field `direction` | 
`lines` |



**Effort Score treatment: all three kinds graduate with weight 0 — argued yes, 
firmly.**

These are the first patent-core measures derived from probabilistic inference 
rather than

direct observation; until field precision is demonstrated, any nonzero weight 
lets detection

noise move a headline score that users must trust, and a visible regression 
there costs more

than a delayed contribution. Rows are still emitted (with confidence) from day 
one, so

production distributions accumulate and the eventual weight calibration uses 
real data, not

fixtures. Graduation is a config change with explicit criteria, not a code 
change:

- `scrolls`: fixture suite green **and** ≥85% event-level agreement vs human 
spot-check on

  20 real recordings → enable at full relative weight (the underlying signal is
already

  production-validated inside context-switch; risk is low).

- `clicks`, `keypresses`: measured precision ≥ 0.80 on that same real set → 
enable;

  otherwise stay at 0 with no shame.

When enabled, aggregate confidence-weighted (`Σ confidence × magnitude_norm` 
per kind,

`magnitude_norm`: clicks=1, keys=count, scrolls=percent/100); the weighting 
formula is

**[TUNE]** at graduation time, not designed now.



**Added CPU budget (2 vCPU, 20-min video):** proxy artifact additions (strips +
diff_energy)

≈ 20 s; audio pass < 10 s; click verification ≈ 10 s; visual-propose mode ≤ 25 
s (silent

recordings only); zoom fallback ≤ 3 s. **Total ≈ 30–60 s typical, ≤ 90 s worst 
case**, on top

of the unchanged existing proxy decode. Hard caps on candidates/windows (§1–§3)
plus the

resolver's hard timeouts bound pathological inputs; on cap exhaustion, 
providers emit at

reduced confidence rather than fail.



---



## 6. Risks (ranked)



1. **Audio environment variance** — mic gain, silent/touch clicks, high noise 
floors, and

   speech masking collapse click/key recall unpredictably per recording.

   *Mitigations:* adaptive thresholds with global floor; per-recording sanity 
gate (zero

   onsets over 20 min despite high visual activity → flag low audio 
sensitivity, cap

   audio-derived confidences at 0.5) **[TUNE]**; two-tier speech policy instead
of blanket

   exclusion; honest low confidences rather than heroic guesses.

2. **Click↔key acoustic confusion** — mechanical keyboards are nearly 
indistinguishable from

   mice per-onset; context features only partly rescue this.

   *Mitigations:* train-context classification as primary; ambiguous class with
suppressed

   low tiers; per-recording 2-cluster spectral adaptation planned v1.1; 
keypresses framed as

   count estimation so residual confusion degrades counts, not claims.

3. **Scroll false positives** — embedded video, parallax, canvas/map drags 
masquerade as page

   scrolls.

   *Mitigations:* 2-of-3 strip dominance test; interior-band geometry; 
scene-cut splitting;

   negative fixtures (autoplaying embedded video → 0 scroll rows); documented 
acceptance of

   map/canvas drags as effort-adjacent.

4. **Fixture optimism** — synthetic ground truth overstates field accuracy and 
could justify

   premature score weights.

   *Mitigations:* metrics labeled `synthetic`; graduation criteria require a 
real-footage

   spot-check; weights ship at 0 (§5). This risk is the reason for the Open 
Question #1.

5. **CPU/timeout blowups on pathological inputs** — 20 min of dense motion 
maximizes strips,

   candidates, and fallback windows simultaneously.

   *Mitigations:* every expensive loop has a hard cap (4000 click candidates, 
300 zoom

   windows); lazy-strips config flag; resolver hard timeouts; 
degrade-to-lower-confidence

   instead of error.



---



## 7. Open Questions



1. **Real-footage validation protocol.** Fixtures cannot establish field 
priors. Is a

   one-time human-labeling exception (~20 real recordings, event-level 
click/key/scroll

   annotation) acceptable as the graduation gate? Who labels, and is 0.80 
precision the right

   bar?

2. **Patent materiality of the null fields.** Are `location`, `context`, and 
double-click /

   right-click distinctions load-bearing for the claims? If yes, v2 scope 
changes materially

   (cursor work, context-menu detection); if counts and timings suffice, v1 
nulls stand.

3. **Proxy geometry confirmation.** This design assumes "480px" = proxy width 
(inferred from

   the 6 px cursor). Confirm against the context-switch implementation; if 
wrong, exactly one

   constant (`H_p` derivation) changes.

4. **Artifact cache lifecycle.** Retention/eviction policy for 
`proxy_motion_v1` /

   `audio_onsets_v1` (≈1–2 MB per video), and invalidation rules on 
builder-version bumps —

   needs an ops decision, not an engineering one.

5. **`combination` scope.** Confirm that emitting no keyboard-shortcut measures
in v1 is

   acceptable for the patent timeline; acoustically they are not separable, and
visual

   shortcut detection is its own project.

---

## Claude's review (2026-07-18)

**Verdict: accepted with three amendments.** Stronger than the F3-b draft — the [TUNE] discipline is self-applied throughout, the click/keystroke acoustic-confusion admission drives the architecture instead of being buried, the two-flash sync marker cleanly solves Playwright's untrustworthy timestamps, and the weight-0-until-real-precision graduation argument is exactly right for score trust. The speech-region policy (raised threshold + visual corroboration instead of blanket exclusion) is the single best product call in the doc.

**Amendment 1 (required):** clicks' `location{x,y}` from the UI-response centroid is NOT the click location — a click can trigger a change far from the cursor (button → panel opens elsewhere). Emit the centroid as payload field `response_centroid` (honest name); `location` stays null in v1.

**Amendment 2 (required):** silent recordings have zero keypress signal in v1 (no audio, text-churn corroboration deferred). The provider must record `skipped: no_audio` in provider_results and the report must not render "0 typing effort" as a finding — absence of signal, not absence of effort.

**Amendment 3 (spec precision):** the in-speech click recall gate (≥0.60) is only meaningful at a controlled mix SNR — pin the narrated fixtures' transient-to-speech ratio (−6 dB per §4b) as a stated constant of the gate.

Implementation order: F10-a fixture harness → F10-b scrolls (lowest risk, promotes the production-validated phase-correlation signal) → F10-c audio onsets artifact + keypresses + clicks.
