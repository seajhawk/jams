# Spec F3-b-fix: repair the two whisper-gated fixture tests

Branch `f1-foundation`. Repro: `PATH="$PATH:/c/Program Files/eSpeak NG"` then `JAMS_RUN_WHISPER_TESTS=1 uv run pytest tests/test_transcription.py` (espeak-ng 1.52 is installed at `C:\Program Files\eSpeak NG`; model cache present). Currently 2 failed / 7 passed.

1. **WER gate fails (20.5% vs 8%):** the `ESPEAK_TEXT` in `worker/scripts/make_fixtures.py` is tongue twisters — pathologically hard for ASR from a robotic voice and unrepresentative of our think-aloud narration domain. Replace with ~60 words of plain task-narration prose (e.g., describing opening a browser, following a tutorial, deploying an app; no digits, no symbols, no tongue twisters, per design §3b normalization). Regenerate fixtures; the 8% gate must pass with margin — report the actual WER.
2. **A/V-sync test raises PipelineError from `ffmpeg version 8.0.1-essentials_build` — a SYSTEM ffmpeg from PATH, not our pinned static-ffmpeg.** Root-cause and fix: every ffmpeg/ffprobe invocation in worker code AND fixture generation must resolve the static-ffmpeg pinned binary explicitly (never bare `ffmpeg` from PATH) — this is the design's determinism pin. Audit `_run_ffmpeg`/probe/proxy/thumbnail/fixture-gen call sites; add a single shared `ffmpeg_path()`/`ffprobe_path()` helper; then fix whatever the actual av_sync failure was if it persists with the right binary. Report the underlying error you found.
3. Full suite green: `JAMS_RUN_WHISPER_TESTS=1 uv run pytest` (all, not just transcription) + `ruff`. Commit logically; push to `origin/f1-foundation` when green (PR #1 is open — do not merge it). Leave user dirty files alone.

Finish: summary (actual WER, av_sync root cause) + scorecard row (✅/⚠️/❌).
