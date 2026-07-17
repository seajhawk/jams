# Spec F3-b3: transcription provider + benchmark gate

Implement §2 of `docs/design/f3b-patent-core-providers.md` exactly (model/config/utterance rules/timestamp invariants/progress). Branch `f1-foundation`.

Scope:
1. FIRST: install espeak-ng so the TTS-pending fixtures activate — try `winget install --id eSpeak-NG.eSpeak-NG -e --accept-source-agreements --accept-package-agreements` (or choco fallback); verify `espeak-ng --version`; regenerate fixtures (make_fixtures.py) and confirm the 3 pending ones (speech_espeak, speech_offsets, av_sync) now generate. If installation is impossible, continue with them skipped and flag loudly in your summary.
2. `worker/src/jams_worker/providers/transcription.py` — provider id='transcription' v1.0.0: faster-whisper distil-small.en INT8 with the design §2b config verbatim; utterance merge/split rules (§2c) → `utterance` (category='speech') + `spoken_word` (category='physical') measures with payloads per design §0; no-audio → skipped_no_audio, silent-audio → partial semantics per §2c; transcript JSON artifact; progress per §2e via the existing heartbeat.
3. Timestamp invariants I1–I3 asserted in-provider (violations → typed error), I4 covered by the av_sync harness test with the context-switch provider (±250ms cross-stage — the patent gate).
4. `worker/scripts/benchmark_whisper.py` — measures RTF on this machine for distil-small.en int8 vs small.en int8 on a 60s+ speech fixture; writes results to `docs/benchmarks/whisper-local.md` (table: model, RTF, wall time). The ACA-SKU benchmark stays a deploy-time gate; this is the local baseline.
5. Tests: WER gates per design (espeak fixture <8%), silence + tones produce zero utterances (hallucination gate), speech_offsets VAD offset verification, av_sync I4 ±250ms, no-audio fixture → skipped_no_audio. Model weights: download on first use to a cache dir (document path); mark model-dependent tests with a pytest marker so CI can gate on cache presence.
6. Live check: enqueue the 2023 sample mp4 (it has narration) through the real worker → succeeded; report utterance count, total spoken words, and the first 2 transcript lines in your summary.
7. Drive-by (one line): context_switch.py params dataclass has unused `confidence_floor` — either apply it as the design intended (final confidence lower bound) or remove it; note which.

Acceptance: `uv run pytest` + `ruff` green; logical commits; no push; leave user dirty files alone. Finish: summary + scorecard row (use the ✅/⚠️/❌ legend).
