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

## What we changed, and the measured comparison

Applied September 19, 2026:

1. **Worker job 2 to 4 vCPU (8 GiB)** in `infra/resources.bicep`. The worker is an ephemeral
   Container Apps job billed per execution second, so libx264 scaling near-linearly with cores
   means about half the wait for about the same cost per video.
2. **Normalize with `-preset ultrafast`** instead of `veryfast`.
3. **Cap the normalized video at 1920 px wide** (never upscaled).

Why 2 and 3 are safe to make: the normalized video is consumed only by `context_switch` and
`physical.clicks`, and both rebuild a 480 px, 5 fps proxy from it (`proxy_motion.py`). Playback
uses the original upload. So the normalized file only needs to be a faithful, timestamp-stable
source for that proxy, not a 4K artifact.

The harness `worker/scripts/normalize_compare.py` runs the production normalize command per
variant, then the real context-switch and click providers on the result, and compares against the
baseline (`veryfast`, native 4K) and against the JEM ground truth. Three real 4K JEM recordings,
`-threads 2` to approximate a small worker (read the ratios, not the seconds):

| Recording | Length | Baseline normalize | ultrafast, 1920 | Context switch, baseline | ultrafast, 1920 |
| --- | --- | --- | --- | --- | --- |
| Email review (the slow staging run) | 6:03 | 138.5 s | 29.2 s (**4.7x**) | 41.0 s | 17.4 s (**2.4x**) |
| Controlled fixture | 1:32 | 34.4 s | 8.3 s (**4.1x**) | 10.3 s | 4.2 s (**2.5x**) |
| IANA website | 0:51 | 18.3 s | 4.5 s (**4.1x**) | 5.6 s | 2.2 s (**2.5x**) |

Effect on what JAMS measures, all variants versus the `veryfast` native baseline:

| Variant | Context switches | Clicks |
| --- | --- | --- |
| ultrafast, native 4K | identical on all 3 | identical on 2; email review +2 extra |
| veryfast, 1920 | identical on all 3 | identical on 2; email review +2 extra |
| ultrafast, 1920 (shipped) | identical on all 3 | identical on 2; email review 1 missed, 3 extra |
| ultrafast, 1280 | identical on all 3 | same as 1920 |

Against JEM ground truth (500 ms tolerance) the matched counts did not move for any variant on
any recording: context switches 10/18, 8/10 and 0/2 matched, clicks 21/40, 7/10 and 1/2 matched,
identical from baseline to 1280 px. The only difference is 2 more unmatched click detections on
the long email recording (91 to 93 extras), which is the recording where clicks already have very
low precision. Context-switch timing shifted by 0 ms everywhere.

Also visible: the accuracy itself is modest on real recordings (context-switch F1 0.34 on the
email review, 0.76 on the controlled fixture; clicks 0.28 and 0.74). Speed work does not change
that, and the known click precision gap is unrelated. It is the next thing worth improving.

Expected effect on the 6 minute 4K run: normalize about 4.7x faster and context switch about
2.4x faster from the settings, then roughly 2x more from the extra cores (assumes near-linear
scaling; verify with `pipeline-perf.sh` after the next real run). That is on the order of 100 to
150 s instead of 755 s. Treat it as a target to confirm, not a result.

Limits of this evidence: three recordings, one machine, silent screen captures. Audio-bearing
recordings also run transcription, which is not affected. If a future recording shows a
difference, `NORMALIZE_PRESET` and `NORMALIZE_MAX_WIDTH` in `providers/probe.py` are the only two
knobs to revert, and the harness reproduces the comparison in a few minutes.

Still open: skipping the re-encode when the original is already compatible (larger win for
already-compatible recordings, but it touches timestamp normalization that the sync work depends
on).

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
