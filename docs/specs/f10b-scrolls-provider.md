# Spec F10-b: scrolls provider (+ fixture-generator browser alignment)

Branch `f10-cv-providers`; push when green. Read `docs/design/f10-physical-effort-providers.md` §0, §3, §5 (now complete) and the Claude review at the bottom.

## Part 0 — unblock the CV fixture generator (do this first)

The pinned Playwright in `worker/scripts/make_cv_fixtures` requires a Chromium build that repeatedly fails to download on this machine (three stalls today; process killed, `__dirlock` cleared). Fix by ALIGNING, not downloading: set that package's `playwright` dependency to exactly the version `apps/web` uses (check its package.json/lockfile), so it reuses the already-cached browser (`ms-playwright/chromium-1148` era builds work with apps/web's E2E today). One browser version repo-wide is the desired end state — note it in the package README. Then: `pnpm install`, `pnpm fixtures --output-dir ../../tests/fixtures/generated` must succeed, and the playwright-marked pytest gates must activate and pass (flash alignment, ground-truth JSONL, determinism double-run).

## Part 1 — `physical.scrolls` provider v1.0.0 (design §3 + §5)

- Extract/build the shared `proxy_motion_v1` artifact from the context-switch provider's existing pass (per §5: build-if-missing, cached; context_switch becomes a consumer too — refactor without changing its behavior or its golden results).
- Promote translation-like motion into scroll measures: direction, magnitude as percent-of-viewport (unit='percent_viewport'), continuous-scroll aggregation into spans (t_start/t_end), interplay/ordering with context-switch suppression exactly per §3/§5. Zoom per §3's scope call (implement only if §3 commits to v1; otherwise leave designed-not-built and say so).
- Payload commitments per §5 table (extension field `direction`; `lines` null). Weight stays 0 in default profiles (graduation policy §5) — verify the scoring provider ignores zero-weight kinds cleanly (it should; parity tests exist).
- Category='physical', confidence per §3.

## Tests + acceptance

- Fixture gates from tolerances.json now active: scroll event count exact (≥1.0s separation), percent ±12% relative, edges ±300ms, direction exact; context-switch golden results UNCHANGED (regression gate on the refactor).
- `uv run pytest` (incl. playwright-marked) + `ruff` green; `pnpm test` untouched-green. Live check: drain-run the 2023 sample — report scroll measures found (count, total distance) and confirm context-switch count still 23.
- Leave user dirty files alone. Finish: summary + scorecard row.
