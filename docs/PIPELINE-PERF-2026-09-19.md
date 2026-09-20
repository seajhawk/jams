# Pipeline throughput: first real recording on staging

Measured September 19, 2026 from the staging worker's structured logs plus the `videos` row.
Reproduce or extend with `scripts/ops/pipeline-perf.sh [days]` (query in
`scripts/ops/pipeline-perf.kql`).

## What we measured

One real recording analyzed on staging (worker: 2 vCPU, 4 GiB, ACA job):

| Input | Value |
| --- | --- |
| Length | 6 min 03 s (362.7 s) |
| Resolution / rate | 3840 x 2160 at 12.47 fps, no audio |
| File size | 29.5 MB |

| Stage | Time | x realtime |
| --- | --- | --- |
| `probe` (download, validate, re-encode to normalized mp4, poster) | 527 s | 1.45 |
| `context_switch` | 226 s | 0.62 |
| Everything else (clicks, scrolls, segmentation, scoring) | about 2 s | 0.01 |
| **Whole run** | **755 s (12.6 min)** | **2.08** |

So a user waits about two minutes per minute of video. The 20 minute upload cap would mean
roughly 42 minutes to a report. The two small earlier runs (8 s clips) finished in about 5 s,
so the fixed overhead is small and the cost is per minute of pixels.

Cost is not the problem: at consumption rates, 755 s of 2 vCPU + 4 GiB is about 4 to 5 cents
of compute. Latency is.

## Where the time goes

`probe` re-encodes the full original with libx264 `-preset veryfast` at native resolution.
For 4K screen recordings that is the single biggest cost, and it is CPU-bound on 2 vCPU.
`context_switch` (about 0.6x realtime) is the second cost and reads the normalized video.

A local benchmark of the encode step alone (synthetic 4K, 12.5 fps, 20 s clip, `-threads 2`,
so only the ratios carry over to ACA):

| Encode | Time | Relative |
| --- | --- | --- |
| veryfast, native 4K (today) | 6.6 s | 1.0x |
| ultrafast, native 4K | 2.6 s | 2.5x faster (2.6x larger file) |
| veryfast, scale to 1920 wide | 2.2 s | 3.0x faster |
| veryfast, scale to 1280 wide | 1.7 s | 3.9x faster |

Synthetic content overstates the absolute numbers, so treat this as direction, not a promise.

## Options, and what each risks

The normalized video feeds `context_switch` and `physical.clicks` (and keypresses). Anything
that changes its pixels can change measure output, so options 1 and 2 must be validated
against the JEM ground truth (`worker/src/jams_worker/jem_eval.py`) before shipping. That is
patent-core territory: the call is Chris's, not a quiet infrastructure tweak.

1. **Downscale in the normalize step (for example cap at 1920 wide).** Biggest win
   (about 3x on the encode, and every downstream reader decodes a quarter of the pixels, so
   `context_switch` likely speeds up too). Risk: small UI changes (checkboxes, cursors) get
   fewer pixels; click and context-switch thresholds may need re-tuning.
2. **`-preset ultrafast`.** About 2.5x faster encode, same geometry. Risk: lower
   compression efficiency, a different noise pattern; larger intermediate blobs
   (roughly 2.6x). Cheaper to validate than option 1 because geometry is unchanged.
3. **More vCPU on the worker job (4 instead of 2).** No accuracy risk. libx264 scales
   close to linearly with cores, so latency roughly halves while cost per video stays about
   the same (twice the cores for half the time). Needs a quota check and a KEDA/job
   resource change in `infra/resources.bicep`. This is the safe first move.
4. **Skip the re-encode when the original is already compatible** (H.264, yuv420p, constant
   frame rate, timebase already zero-origin). Large win for recordings that already meet the
   contract, none for the rest. Needs care: the normalize step also fixes timestamps and pads
   audio, which the timestamp-integrity work depends on.

Recommendation: do 3 now (no risk), then run the JEM eval with 2 and then 1 to see whether
the accuracy holds. Measure with the new telemetry after each change.

## Telemetry added with this note

The worker now logs, per run:

- `media_profile`: length, resolution, fps, audio presence and original size, emitted right
  after validation so even a run that later fails is accounted for.
- `probe_timings`: milliseconds spent downloading, validating, normalizing, uploading the
  normalized video, extracting audio and making the poster.

With those, `pipeline-perf.sh` prints processing time per second of video for every run and
splits the probe stage, so any future change (encoder settings, worker size, model swap) has
a before and after number instead of a guess.

## Not yet measured

- Transcription throughput on real narrated audio (both earlier runs were 8 s clips; the 6
  minute run had no audio). The whisper benchmark in `PREVIEW-READINESS.md` is still open.
- Concurrent runs and cold start of a scaled-from-zero worker.
