# Spec F3-b2: context-switch provider

Implement §1 of `docs/design/f3b-patent-core-providers.md` exactly, INCLUDING the two amendments in the "Claude's review" section at the bottom (low phase-correlation-response exemption for cuts-into-scroll; the phase-corr thresholds and borderline multiplier are tuning-set parameters, structured as named constants in a params dataclass with a provenance comment). Branch `f1-foundation`.

Scope:
1. `worker/src/jams_worker/providers/context_switch.py` — provider id='context_switch' v1.0.0 in the existing MeasureProvider framework (see providers/ and pipeline.py from F3-a): 5fps/480px proxy generation (ffmpeg per design §1a), PySceneDetect AdaptiveDetector with the committed params, scroll/drag post-filter with the amendment, confidence formula (§1c, recomputed from StatsManager content_val series), full-res keyframe thumbnails at cut+0.5s registered as artifacts with deterministic blob keys, measures written via the idempotent helper (payload per design §0).
2. dHash fallback detector (§1e) behind the same interface, selectable via provider param `detector_impl`.
3. Wire into the pipeline's provider order after probe. New deps: scenedetect, opencv-python-headless, imagehash (or inline dHash — your call, note it).
4. Tests: green against the F3-b1 harness — synth_switches (exact count, each ±1s), synth_tabs, synth_scroll (only the planted 10s cut survives), synth_drag (zero cuts), synth_idle (zero cuts); run BOTH detectors on all video fixtures and report the comparison table in your summary. Unit tests for confidence formula and the post-filter decision rule (incl. the cut-into-scroll exemption case — synthesize the frame series in-test if no fixture covers it).
5. Live check: enqueue the 2023 sample mp4 through the real worker (docker compose + enqueue_local.py per F3-a) → run succeeds, context_switch measures + thumbnails exist; report the cut count.

Acceptance: `uv run pytest` + `ruff` green; `pnpm test` untouched-green; logical commits; no push; leave user dirty files alone. Finish: summary + detector comparison table + scorecard row (delegate=Codex, model, grade, note).
