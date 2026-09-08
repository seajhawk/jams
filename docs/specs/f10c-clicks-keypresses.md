# Spec F10-c: clicks + keypresses providers (audio-first)

Branch `f10-cv-providers`; push when green. Implement §1, §2, §5 of `docs/design/f10-physical-effort-providers.md` INCLUDING review Amendments 1 and 2 (UI-response centroid ships as payload `response_centroid`, `location` null v1; silent recordings persist `skipped: no_audio` in provider_results and must never read as zero typing effort).

Scope:
1. `audio_onsets_v1` artifact builder per §1a/§5: band-limited spectral flux front-end, adaptive MAD threshold with global floor, the 12-dim per-onset features, train classification (typing trains / click_candidate / ambiguous), speech-region policy (±120ms VAD pad, ×1.6 in-speech threshold, `requires_visual` marking, `speech_policy='exclude'` config fallback). All [TUNE] constants as a params dataclass with provenance comments.
2. `physical.keypresses` v1.0.0 per §2: typing trains → burst measures ({type:'multiple', count}, span, value_num=count, unit='keys'), pause-split rules, count-estimator confidence semantics; no-audio → skipped per Amendment 2.
3. `physical.clicks` v1.0.0 per §1: audio-proposes-vision-verifies using `proxy_motion_v1` diff_energy (add the interior-region diff to the shared artifact per §1b if not already emitted by F10-b's builder), `verify_visual` window logic, confidence tiers per §1c, visual-propose mode for silent recordings per §1b. Payload per §5 table + Amendment 1.
4. Execution order per §5; both providers weight 0 in default profiles (verify scoring ignores them; contract already knows the kinds from F10-b's wiring — extend for clicks/keypresses the same way).
5. Fixture gates from tolerances.json now activate: audio click counts exact ±75ms (no speech), in-speech recall ≥0.60/precision ≥0.85 at the pinned −6 dB, key burst counts exact ≤8 keys/s, negatives zero rows, integration fixtures incl. the +300ms desync graceful-degradation probe, visual-path click gates on the Playwright button-grid fixture.
6. `uv run pytest` (all markers) + `ruff` + `pnpm test` green. Live check: drain-run the 2023 sample — report click count (by confidence tier), keypress bursts + estimated keys, and the provider_results entries; that recording has continuous narration, so the in-speech policy gets a real workout.
7. Leave user dirty files alone. Finish: summary + scorecard row.
