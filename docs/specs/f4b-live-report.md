# Spec F4-b: bind the report to live runs (MVP closer)

Branch `f1-foundation`. Prereq: F4-a landed (scoring writes effort_scores; all measure kinds exist). The F1 report components under `apps/web/src/components/report/` take a validated payload as props and MUST NOT be modified except where noted — this slice feeds them real data.

1. `GET /api/analyses/[id]/report` (withOrg): assemble the exact `reportPayloadSchema` shape (see `src/lib/report-contract.ts`) from analysis_runs + video + task + segments + measures + effort_scores + the org default weight_profile; `video.playback_url` = fresh 1-hr read SAS; `run.warnings` from partial/error state (typed codes → friendly messages). Validate the assembled payload with the zod schema server-side before returning (the contract is the guard). 404 cross-org.
2. Report page `/reports/[runId]` (server component): fetch via the route logic (shared function, not an HTTP self-call), render the existing ReportShell. Skeleton while loading; `partial` runs render with an honest banner + retry button (re-POST /api/analyses); `failed` runs get a typed-error page with retry.
3. Weight profiles: `GET /api/weight-profiles` + `PATCH /api/weight-profiles/[id]` (withOrg, default profile only for now). ScoreTab gains a "Save as org default" button (persists weights; client recompute stays instant). Minimal change to ScoreTab only.
4. Library + video detail: when a run reaches succeeded/partial, "View report" links to `/reports/[runId]` (replace the F3-a placeholder). Demo card on Library labeled "Sample report".
5. Tests: route test assembling a report payload from seeded DB rows validates against the zod schema; Playwright spec: seed a run + measures directly in DB (reuse fixture JSON data), visit `/reports/[runId]`, assert score dial + timeline render and a transcript-row click seeks the player. Existing suites stay green (`pnpm test/lint/build`, `pnpm test:e2e`).
6. Live manual path for your summary: with worker running, Analyze the already-uploaded 2023 video (or reuse run a1735e94-...) and confirm `/reports/[runId]` renders the real report end-to-end; report the URL path and what the timeline shows.

Logical commits; no push; user dirty files untouched. Finish: summary + scorecard row (✅/⚠️/❌ legend).
