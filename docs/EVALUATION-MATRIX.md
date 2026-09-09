# JAMS evaluation matrix

JEM recordings and deterministic fixtures are the primary evaluation system for analysis providers. Each candidate change is measured on a development split, then reported without retuning on a holdout split grouped by participant and task. Vally is reserved for agent or CLI behavior evaluations; it is not the runner for local CV, audio, or scoring-model benchmarks.

## Provider and system measures

| Area | Ground truth | Core measures | Release evidence still needed |
|---|---|---|---|
| Synchronization | JEM start/end flashes | start offset, end drift, per-segment drift | timestamp agreement through the production CFR artifact, ≤250 ms |
| Context switches | JEM foreground/title spans plus human-labelled visual changes | precision, recall, F1, count accuracy, mean/95th absolute timing error, false positives per minute | holdout results split by page change, scroll, static dwell, and app switch |
| Physical activity | JEM clicks, keys, scrolls | event precision/recall, count error, timing error | no JAMS visual/acoustic physical provider exists yet; retain as weight-0 |
| Transcription | consented transcript and word bounds | WER, word-bound timing error, utterance coverage, real-time factor, failure rate | real narration benchmark on target CPU; plan gate WER <5% and RTF ≤0.6 |
| Narration sentiment | independently labelled utterances with neutral examples | macro F1, neutral false-positive rate, calibration error, coverage | labels from representative participants; never treat classifier probability as effort confidence |
| Segmentation | task-boundary annotations | boundary precision/recall, temporal IoU, over/under-segmentation rate, naming coverage | holdout task recordings and agreement between raters |
| Effort score | fixed measure inputs and participant/task feedback | Python/TypeScript parity, missing-signal handling, score stability, correlation with independent workload feedback | validity study; no current accuracy claim is justified |
| Pipeline reliability | controlled fixtures and production-like runs | upload/probe success, normalized-video duration delta, provider partial/failure rate, runtime, peak memory, retry idempotency | target ACA SKU benchmark and live staging run |

## Current local variants

| Signal | Current implementation | Variants that can be evaluated now |
|---|---|---|
| Context switch | AdaptiveDetector plus motion/scroll post-filter | adaptive parameters and dHash fallback |
| Transcription | faster-whisper `distil-small.en`, CTranslate2 INT8 | model selection must first become per-run configuration; compare `distil-small.en`, `small.en`, and `base.en` against WER and runtime |
| Sentiment | Xenova DistilBERT SST-2 INT8 ONNX | deterministic VADER fallback already supported by per-run config |
| Segmentation and score | deterministic rules and arithmetic | parameter/config variants, measured against fixed annotations and parity checks |

## Evaluation rules

1. Keep original JEM CSV, manifest, and video outside Git; commit only fixture recipes, redacted labels, metrics, and reports.
2. Use JEM for physical-event truth. A browser automation extension can alter a page without producing low-level desktop events, so it is not valid physical ground truth.
3. Keep detector settings fixed while scoring a holdout. Do not alter timing tolerances or exclude difficult samples after looking at their scores.
4. Report missing providers as missing. A silent recording is not evidence of zero typing, speech, sentiment, or effort.
5. Treat foreground/title spans as proxy labels for visual context. Report them separately from human task-boundary annotations.

## Vally scope

Vally is not configured in this checkout. If we add it, pin `@microsoft/vally-cli` as a workspace development dependency and commit a `.vally.yaml` with an explicit executor. Initial suites should evaluate agent-driven repository tasks: preserve tenant isolation, add canonical measures only, run required tests, and avoid LLM calls in CI. Results stay separate from the deterministic JEM provider benchmark.
