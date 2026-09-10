# JAMS evaluation matrix

JEM recordings and deterministic fixtures are the primary evaluation system for analysis providers. Each candidate change is measured on a development split, then reported without retuning on a holdout split grouped by participant and task. Vally is reserved for agent or CLI behavior evaluations; it is not the runner for local CV, audio, or scoring-model benchmarks.

## Provider and system measures

| Area | Ground truth | Core measures | Release evidence still needed |
|---|---|---|---|
| Synchronization | JEM start/end flashes | start offset, end drift, per-segment drift | timestamp agreement through the production CFR artifact, ≤250 ms |
| Context switches | JEM foreground/title spans plus human-labelled visual changes | precision, recall, F1, count accuracy, mean/95th absolute timing error, false positives per minute | holdout results split by page change, scroll, static dwell, and app switch |
| Physical activity | JEM clicks, keys, scrolls | event precision/recall, count error, timing error | Clicks, keypress bursts, and scroll events are implemented experimental providers, but the current JEM evaluator is context-switch-only and does not score them; retain as weight-0 until dedicated physical-event labels and evaluation runs exist |
| Transcription | consented transcript and word bounds | WER, word-bound timing error, utterance coverage, real-time factor, failure rate | real narration benchmark on target CPU; plan gate WER <5% and RTF ≤0.6 |
| Narration sentiment | independently labelled utterances with neutral examples | macro F1, neutral false-positive rate, calibration error, coverage | labels from representative participants; never treat classifier probability as effort confidence |
| Segmentation | task-boundary annotations | boundary precision/recall, temporal IoU, over/under-segmentation rate, naming coverage | holdout task recordings and agreement between raters |
| Effort score | fixed measure inputs and participant/task feedback | Python/TypeScript parity, missing-signal handling, score stability, correlation with independent workload feedback | validity study; no current accuracy claim is justified |
| Pipeline reliability | controlled fixtures and production-like runs | upload/probe success, normalized-video duration delta, provider partial/failure rate, runtime, peak memory, retry idempotency | target ACA SKU benchmark and live staging run |

## Current local variants

| Signal | Current implementation | Variants that can be evaluated now |
|---|---|---|
| Context switch | AdaptiveDetector plus motion/scroll post-filter | adaptive parameters and dHash fallback; a run can now record an explicit `context_switch.params` variant |
| Physical activity | `physical.clicks`, `physical.keypresses`, and `physical.scrolls` providers are registered in the worker and emit canonical physical measures | detector parameter variants can be evaluated once JEM sessions include suitable event labels; current controlled-journey reports explicitly exclude these kinds |
| Transcription | faster-whisper `distil-small.en`, CTranslate2 INT8 | model selection must first become per-run configuration; compare `distil-small.en`, `small.en`, and `base.en` against WER and runtime |
| Sentiment | Xenova DistilBERT SST-2 INT8 ONNX | deterministic VADER fallback already supported by per-run config |
| Segmentation and score | deterministic rules and arithmetic | parameter/config variants, measured against fixed annotations and parity checks |

## Evaluation rules

1. Keep original JEM CSV, manifest, and video outside Git; commit only fixture recipes, redacted labels, metrics, and reports.
2. Use native JEM input records for physical-event truth when running a physical-provider evaluation. The current controlled-journey evaluator is context-switch-only and excludes click, keypress, and scroll measures. A browser automation extension can alter a page without producing low-level desktop events, so it is not valid physical ground truth.
3. Keep detector settings fixed while scoring a holdout. Do not alter timing tolerances or exclude difficult samples after looking at their scores.
4. Report missing providers as missing. A silent recording is not evidence of zero typing, speech, sentiment, or effort.
5. Treat foreground/title spans as proxy labels for visual context. Report them separately from human task-boundary annotations.

## Vally scope

Vally CLI 0.15.0 is pinned as a workspace development dependency. `.vally.yaml`
defines the manual `agent-guardrails` suite, and `pnpm eval:lint` validates its
spec without an agent or model call. `pnpm eval:agent -- --model <model>` runs
three trials with Vally's `copilot-sdk` executor. It is intentionally absent
from CI because executing an agent is not a deterministic test. The initial
suite checks that an agent states the tenant, canonical-measure, CFR-timestamp,
and no-LLM-in-CI requirements. Results stay separate from the deterministic JEM
provider benchmark.

For detector hillclimbs, record the exact configuration in the server-side
analysis run, for example `context_switch.params.min_content_val: 4`. The
provider rejects unknown, non-numeric, non-finite, and invalid-range overrides.
This permits an evidence-backed variant comparison without silently changing the
production default. The low-floor variant recovered the two weak controlled
transitions during diagnostic replay, but it also produced a website-scroll
candidate in the IANA holdout. It is therefore a candidate to label and compare,
not the selected production default.
