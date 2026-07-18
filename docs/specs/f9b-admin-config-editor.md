# Spec F9-b: platform admin + analysis config editor

Branch `f1-foundation`; push when green. Read docs/PLAN.md §F9. Prereq: F9-a landed (`adminDb` bypass client exists, server-only).

## Platform admin (`/admin`)

1. Gate: `ADMIN_USER_IDS` env (comma-separated Clerk user ids). Server-side check in the layout for `/admin/*`; non-allowlisted → 404 (not 403 — don't advertise the route). Add Chris's local id via .env.example placeholder + README note.
2. Runs dashboard (adminDb, platform-wide): table of runs filtered by status (failed | partial | stuck = running with no heartbeat update > 60 min), columns org/video/stage/error_code/attempt/started, expandable row showing error_detail + provider_results JSON. Actions per row: **Requeue** (reset to queued + send queue message — reuse the F3-a queue helper), **Mark failed** (stuck runs; the watchdog action, manually). Both idempotent and logged to console.
3. Poison queue panel: peek `analysis-jobs-poison` messages (id, dequeue count, body), actions: requeue to main queue, delete. Storage Queue peek APIs via the existing queue helper.
4. Wire the existing `POST /api/admin/watchdog` to the same allowlist gate (it currently trusts the GitHub Actions schedule; local calls must be admin-gated).

## Analysis config editor (patent: user-configurable analyses)

5. Canonical config schema: `src/lib/analysis-config.ts` — zod schema for run config: per-provider `enabled` (probe/context_switch/transcription immutable-on for v1 — document why: downstream deps), `context_switch: { detector_impl: 'adaptive'|'dhash' }`, `sentiment: { fallback: 'none'|'vader' }`, `llm_labeling: { enabled }`, segmentation cue-list override (`segmentation: { extra_cues: string[] }` — worker already reads config; extend the segmentation provider to union extra_cues if trivial, else note as follow-up). Export JSON-Schema via zod for display.
6. Re-analyze dialog gains an "Advanced" collapsible: YAML editor (small — `yaml` npm package, no Monaco) prefilled with the current config as YAML; client-side parse → zod validate → inline errors with paths; on submit store canonical JSONB in `analysis_runs.config` plus the as-authored text in new nullable column `config_source` (migration). Default flow (no YAML touched) unchanged.
7. Worker: no changes required beyond (5)'s optional extra_cues; config it doesn't recognize is ignored-with-log (already the pattern).

## Tests + acceptance

8. Admin gate (404 for non-allowlisted incl. signed-in users), requeue/mark-failed route tests, YAML round-trip + validation-error cases, config schema unit tests. `pnpm test/lint/build` + `test:e2e` twice + `uv run pytest` green.
9. User dirty files untouched. Finish: summary + scorecard row.
