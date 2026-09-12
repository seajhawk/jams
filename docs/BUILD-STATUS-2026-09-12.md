# Narrated pipeline verification — September 12, 2026

The local narrated upload-to-report E2E passed in Chromium in 24.0 seconds
(51.5 seconds including Playwright setup). The generated video uses a known
espeak-ng phrase beginning at 4000 ms, with visual cuts at 4000 and 8000 ms.
Actual cached Whisper and ONNX sentiment models run offline; no report results
are seeded and no API requests are mocked.

The report completed successfully without warnings, included speech, words,
sentiment, segmentation and scoring, and retained both exact cut timestamps.
The first utterance began at 3900 ms (100 ms before the known onset, within the
250 ms tolerance). Completed native video seeking reached 4000 ms for the context
measure and 3900 ms for the transcript. The transcript test resets playback to
zero before clicking, avoiding a false pass from already being at the target.
The persisted report score was 79; this synthetic phrase is a pipeline smoke test,
not a sentiment-accuracy or customer-performance benchmark.

The runner now supports `-Narrated` and retains JSON test evidence in its owned
temporary directory. See [PIPELINE-E2E.md](PIPELINE-E2E.md). Astra reviewed fixture,
assertion and runner changes with no actionable findings. Luna inspected the
existing fixture and drafted the spec before a quota interruption; the primary
completed the seek checks, Windows reporter quoting and runtime verification.
The unchanged silent scenario also passed (14.8 seconds), and TypeScript,
targeted ESLint, fixture Ruff and the production build passed.

Next milestone: real failure/retry coverage. Then continue the detector quality
loop, including the previously recorded narrated-click precision failure
(6 TP / 126 FP / 0 FN before visual verification). No thresholds were weakened.
Azure deployment and customer invitations remain deferred.
