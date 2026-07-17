# Spec F7: Comparison v1 — same task, side by side

Branch `f1-foundation`. Read docs/PLAN.md §F7. Pure read-side over canonical measures — no worker changes, no schema changes. Reuse `assembleReportPayload` and the report components; report components may gain OPTIONAL props only (no behavior change for existing pages).

## API

1. `GET /api/compare?runs=<idA>,<idB>` (withOrg): both runs must belong to the org, be succeeded|partial, and share the same task_id (400 with typed error otherwise). Return `{ a: ReportPayload, b: ReportPayload, comparison }` where `comparison` is computed server-side in a pure, unit-tested module `src/lib/compare.ts`:
   - `score`: per-component + total deltas (b − a) using each run's stored default-profile snapshot
   - `kinds`: per-kind normalized deltas + raw rates (switches/min, words/min, negative-sentiment density, minutes)
   - `segments`: positional alignment pairs [{a_segment, b_segment, duration_delta_ms}] over min(countA, countB); `alignment: 'positional' | 'positional_partial'` when counts differ (leftover segments listed as unmatched)
   - subject_label/variant_label of each video surfaced for header framing

## UI (`/compare?runs=a,b`)

2. Header: task name; two run cards (video title, subject/variant chips, date) with score dials side by side and a delta chip on each component (green = less effort in B, red = more; tooltip explains direction).
3. Segment comparison: horizontal paired bars per aligned segment (A over B, shared ms scale), duration delta labels, unmatched segments rendered dimmed with an "unaligned" note when partial.
4. Kind deltas: chips/mini-table from `comparison.kinds`.
5. One active player (tabs A|B) fed by the payload the tab selects; clicking a segment bar seeks the active player if it belongs to that run, else switches tab first. Reuse VideoPlayer.
6. Entry points: Tasks page and Library task filter — "Compare runs" appears when a task has ≥2 scored runs; simple picker dialog (two selects of that task's runs) → navigates to /compare.

## Tests + acceptance

7. Unit: compare.ts math (deltas incl. sign convention, positional alignment equal/unequal counts, partial flag). Route: org scoping, mismatched-task 400. E2E: seed two runs of one task (fixture-based like live-report.spec), assert dials + delta chips + paired bars render and tab-switch seek works.
8. `pnpm test/lint/build` + `pnpm test:e2e` green; push to origin when green (PR #1 open, do not merge). User dirty files untouched. Finish: summary + scorecard row (✅/⚠️/❌).
