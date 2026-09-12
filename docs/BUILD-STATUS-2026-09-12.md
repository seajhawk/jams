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

## Follow-up: failure and retry verified

The `-Recovery -Narrated` scenario passed in 28.1 seconds (32.7 seconds including
Playwright setup). The test corrupts only its own uploaded original on local
Azurite, verifies the real worker's `corrupt_file` failure and absence of a report,
restores the valid fixture, and clicks Retry. A distinct new run succeeds, while
the failed run retains its error and points to the replacement via `superseded_by`.
The successful report passes the existing real-model and video-seek assertions.
Worker logs show the corrupt message handled as poisoned in 105 ms and the
replacement analysis completed in 5007 ms. No production behavior was changed.

TypeScript, targeted ESLint and production build passed. Luna checked the worker
and UI recovery contracts; Astra reviewed fault isolation, restoration and
assertions with no actionable findings. This is repaired-input recovery; automatic
redelivery during transient infrastructure outages remains a separate scenario.

Next milestone: continue the detector quality
loop, including the previously recorded narrated-click precision failure
(6 TP / 126 FP / 0 FN before visual verification). No thresholds were weakened.
Azure deployment and customer invitations remain deferred.

## Audio detector diagnosis checkpoint

Added `worker/scripts/diagnose_audio_onsets.py` and five metric/input regression
tests. The reproducible report includes proposal features, duplicate-aware matches,
clean clicks and speech/music/tone/silence controls; missing controls or positive
ground truth fail explicitly. See `AUDIO-ONSET-DIAGNOSTICS.md` for invocation and
baseline. Clean clicks are 6 TP / 0 FP; pure speech generates 130 raw proposals.
The narrated golden test still fails at 6 TP / 126 FP / 0 FN. No production
detector or quality gate was changed. Targeted diagnostic tests and Ruff pass.
Luna independently confirmed the speech-proposal cause; Astra identified missing
input validation, which was fixed with regression tests.

## Expanded audio robustness experiment

CI passed for `d951a25`. Luna built `make_audio_holdouts.py`: 27 crossed synthetic
phrase/voice/volume cases, paired speech-only controls and shared normalization.
The primary added `evaluate_audio_holdouts.py` for three predeclared variants.
Final results were repeated after generation completed: baseline 162 TP / 3740 FP;
threshold 3.2 gives 132 TP / 257 FP / 30 FN; spectral filter gives 111 TP / 623 FP /
51 FN. Neither candidate is accepted. The initial evaluation overlapped fixture
revision and is superseded by these final, stable counts.

Luna verified deterministic generation; Astra reviewed both scripts and found a
mislabeled RMS window, corrected to 400 ms. Diagnostic regression tests (5) and
worker Ruff pass. Details and commands are in `AUDIO-ONSET-DIAGNOSTICS.md`.
No production thresholds changed. Next: investigate temporal transient shape
with fresh evaluation data; simple threshold and spectral filters are insufficient.

The temporal contrast evaluator is now included in the worktree. Across the same
27 crossed cases, fixed 4--8 kHz contrast thresholds 2/4/8 reached 8.79%/17.65%/
25.70% precision with 8/19/34 missed clicks. All remain below the 85% gate. The
production onset path also received a semantics-preserving optimization: frame
energy for decay is computed once per recording. Full artifacts were byte-equivalent
to the prior implementation across 54 WAVs, reducing a benchmark from 13.4s to
3.0s. The full worker suite is 170 passed, 8 skipped, and the pre-existing narrated
click precision gate fails (6 TP / 126 FP / 0 FN).
