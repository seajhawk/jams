# Spec F9-a: Postgres RLS defense-in-depth

Branch `f1-foundation`; push when green. Read docs/PLAN.md §F9 and §Architecture/Multi-tenancy. This hardens the app-layer `withOrg` chokepoint with database-enforced isolation. Design decisions below are fixed — implement, don't redesign.

## Roles & enforcement model

1. Migration creates two DB roles (idempotent, compose-friendly): `jams_web` (RLS ENFORCED — no bypass) and `jams_worker` (`BYPASSRLS` — trusted infrastructure; it claims runs by id from queue messages before org context exists). Grant table privileges appropriately. Local compose + .env.example gain `DATABASE_URL_WEB` (jams_web) and worker keeps a bypass-capable URL; migrations continue to run as the owner role.
2. ENABLE ROW LEVEL SECURITY + FORCE on all tenant tables (orgs, tasks, videos, analysis_runs, analysis_artifacts, measures, segments, weight_profiles, effort_scores, share_links, webhook_events where org-scoped). Policy per table: `USING (org_id = current_setting('app.org_id', true))` for SELECT/INSERT/UPDATE/DELETE (WITH CHECK mirrored). `orgs` policies key on `id`.
3. `share_links` additionally gets a SELECT-only policy `USING (true)` — the 256-bit unique token in the WHERE clause is the capability; after resolving a link, the share page sets `app.org_id` from the link row for the rest of the assembly (cross-org by design, token-gated).

## Web integration

4. `scopedDb` refactor: every query path runs inside a transaction that first executes `SET LOCAL app.org_id = <orgId>` (parameterized via sql template, never string-concat). Public share path: resolve link, then same transaction pattern with the link's org. Webhook handlers (org events arrive before mirror rows exist): run as a small allowlist of operations using the owner/worker connection — document each usage with a comment justifying bypass.
5. The web app's runtime connection switches to `DATABASE_URL_WEB`. Keep a clearly-named `adminDb` (bypass connection) exported ONLY from a server-only module — currently used by webhooks; F9-b's admin page will use it behind a Clerk user-id allowlist.

## Tests (the point of the exercise)

6. **Leakage test:** integration test against real Postgres — seed two orgs' rows; using the jams_web connection with org A's `app.org_id`, run a DELIBERATELY unfiltered select on videos/measures (no orgFilter) and assert only org A rows return; with no app.org_id set, assert zero rows. This test failing loudly on RLS regressions is the deliverable.
7. Existing suites all green under the new connection model: `pnpm test/lint/build`, `pnpm test:e2e` twice, `uv run pytest` + ruff (worker behavior unchanged — verify one live drain run against the compose stack completes with the worker URL).
8. User dirty files untouched. Finish: summary + scorecard row.
