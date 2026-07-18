# Spec F10-a: physical-effort fixture harness

Implement §4 of `docs/design/f10-physical-effort-providers.md` exactly, including Amendment 3 from the Claude review (pin the −6 dB transient-to-speech mix ratio as a stated constant). Branch `f10-cv-providers`; push when green (no PR yet).

Scope:
1. Playwright video-fixture generator (`worker/scripts/make_cv_fixtures/` — a small pnpm-run Node/Playwright package or python-playwright, your call, pinned): the §4a pages (scroll page with fixed line-height, button grid with :active states, hover-animation negative), `addInitScript` event capture to JSONL, the **two-flash sync marker** exactly as designed, production-ffmpeg CFR normalization of the recorded WebM.
2. Audio-fixture synthesis per §4b in `make_fixtures.py` (extend the existing generator): click/keystroke transient recipes, seeded jitter, offsets JSONL, espeak narrated variants at the pinned −6 dB, negatives (pure speech, music bed). Run narrated WAVs through the real transcription provider to produce the VAD/transcript artifacts fixtures consume.
3. Integration family per §4c: muxed video+audio at 0 ms and the +300 ms desync robustness probe.
4. `tolerances.json` — every §4d gate in one auditable file; golden.py gains the flash-detection + offset/drift alignment helpers (assert 2 flashes, drift ≤200 ms, linear map fallback per the pseudocode).
5. Harness self-consistency tests green NOW (no F10 providers exist yet): fixtures generate deterministically (double-run compare on ground-truth JSONL), flash alignment resolves on every video fixture, ffprobe durations match, audio offset lists parse. Mark provider-dependent assertions as pending fixtures for F10-b/c.
6. `uv run pytest` + `ruff` green; Playwright generator documented in worker README (espeak + Playwright/Chromium prereqs; skip-with-marker when absent). Leave user dirty files alone. Finish: summary + scorecard row.
