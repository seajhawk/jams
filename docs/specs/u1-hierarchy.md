# U1: Projects, goals, journeys, participants, variants, and the comparability fingerprint

Design: `docs/design/customer-journeys-ux.md` (§3, §5, §6, §8 U1). Branch: `u1-hierarchy`
(never push `main` from this work; pushing `main` deploys). Decisions taken with the owner away,
per the design's recommendations: UI says **Goal** (not Job) and **Session** (not Recording);
participants are pseudonymous labels; "winner" language needs 5 sessions per group (guidance only,
U2); re-analysis is offered, never automatic (U2); Library stays as **All sessions**.

## Data model (migration 0015)

- `projects` (id, org_id, name, description, created_at; unique org_id+name)
- `goals` (id, org_id, project_id → projects cascade, name, description, success_criterion,
  created_at; unique project_id+name)
- `tasks` **is the journey table** (SQL name unchanged so existing routes, runs and data keep
  working): add `goal_id` → goals (set null), `steps` jsonb default `[]` (ordered step names),
  `status` text default `active` (`active` | `retired`). Replace unique org_id+name with unique
  goal_id+name (the same journey name can exist under two goals).
- `participants` (id, org_id, label, cohorts text[] default `{}`, notes, created_at; unique
  org_id + lower(label))
- `variants` (id, org_id, task_id → tasks cascade, name, build, created_at; unique task_id+name)
- `videos` add `participant_id` → participants (set null), `variant_id` → variants (set null).
  Keep `subject_label`/`variant_label` (read-only legacy, still written by old clients).
- `analysis_runs` add `fingerprint` jsonb and `fingerprint_hash` text (see Worker).
- RLS on every new tenant table: ENABLE + FORCE, `<table>_org_isolation` policy TO jams_web on
  `org_id = current_setting('app.org_id', true)`, and explicit `GRANT SELECT, INSERT, UPDATE,
  DELETE` to `jams_web` (default privileges only cover jams_worker).
- Backfill: per org that has tasks, one project named "My product"; one goal per existing task with
  the task's name; `tasks.goal_id` set. Participants from distinct trimmed `subject_label`
  (case-insensitive), linked back to videos. Variants from distinct (task_id, trimmed
  `variant_label`), linked back. Idempotent (safe to re-run).

## API (all through `withOrg`, zod-validated, 409 on unique violations)

- `GET /api/catalog`: projects → goals → journeys, each journey with `session_count`,
  `analyzed_count`, `median_total` (latest succeeded/partial run per session), `fingerprint_count`
  (distinct fingerprint hashes among those latest runs).
- `POST /api/projects`, `PATCH /api/projects/[id]` (name, description).
- `POST /api/goals` (project_id, name, description?, success_criterion?), `PATCH /api/goals/[id]`.
- `/api/tasks`: create accepts `goal_id` (required for new journeys created from the new UI,
  optional for old clients), `steps?`; list returns `goal_id`, `steps`, `status`.
  `PATCH /api/tasks/[id]` (name, description, goal_id, steps, status).
- `GET/POST /api/participants` (label, cohorts[]), `PATCH /api/participants/[id]`.
- `GET /api/variants?task_id=`, `POST /api/variants` (task_id, name, build?).
- `POST /api/videos` accepts `participant_id?`, `variant_id?` (validated to belong to the org and,
  for variants, to the chosen task).
- `GET /api/journeys/[id]/summary`: journey + goal + project, sessions with participant, cohorts,
  variant, latest analysis (id, status, total score, fingerprint_hash), and stats (n, median,
  p25, p75 of latest totals) plus `mixed_definitions: boolean`.

## Worker

- On run completion, write `fingerprint` = `{pipeline_version, provider_versions, models:
  {sentiment: <model_id>}, score_formula: "2026-09-26"}` and `fingerprint_hash` = first 12 hex of
  sha256 of its canonical JSON. `SCORE_FORMULA_VERSION` constant lives next to
  `NEGATIVE_SENTIMENT_THRESHOLD` in `effort_score.py`; bump it on any score formula change.

## UI

- Nav: **Projects** (new, first), **All sessions** (the Library, renamed label only), Compare,
  Settings. `/tasks` redirects to `/projects`.
- `/projects`: tree of projects → goals → journeys with counts and median effort; inline create at
  every level; empty state offers "Start from an example" (creates the JAMS dogfooding project from
  the design §1) or "Start blank".
- `/projects/[id]`: goals with their journeys as rows (n, median effort, last session date).
- `/journeys/[id]`: breadcrumbs, header stats (n, median, p25–p75), strip plot of session totals,
  sessions table (participant, cohorts, variant, date, score, link to report), filters by cohort
  and variant, a "mixed scoring definitions" notice when `mixed_definitions`, and "Compare two
  sessions" into the existing compare page.
- Upload dialog: "Which journey?" type-ahead over project › goal › journey with inline create of
  goal/journey; optional participant (autocomplete + create with cohort chips) and variant
  (per journey, autocomplete + create). Remember last choices per browser.
- Session page (`/library/[id]`): breadcrumbs and participant/cohort/variant chips.

## Tests

- Unit (vitest): new zod schemas; catalog/summary stats (median/percentiles with 0, 1, even n);
  upload payload building.
- Integration (real Postgres, `*.integration.test.ts`): new tables appear in the RLS catalog test
  and isolate; migration backfill on a seeded pre-0015 database; variant/participant cross-org
  rejection.
- Worker (pytest): fingerprint shape and hash stability.
- Playwright: create project → goal → journey, upload into it with a participant and variant, see
  it on the journey page.

## Progress

- [x] Schema + migration 0015 (+ RLS, grants, backfill) and snapshot. Verified on local Postgres 16: backfill on seeded pre-0015 data (case/space dedupe, per-org isolation, no-task variants skipped), idempotent re-run, RLS catalog test covers the new tables (fails when one is unprotected).
- [x] Worker fingerprint (`fingerprint.py`, `RunRepository.set_fingerprint` with lease fencing, `SCORE_FORMULA_VERSION`); unit + Postgres integration tests.
- [x] APIs: catalog, projects, goals, tasks extensions, participants, variants, videos, journey summary (`lib/hierarchy.ts`); unit + Postgres integration tests (latest-run selection, default-profile totals, quartiles, mixed definitions, cross-org isolation and id rejection).
- [ ] UI: nav, /projects, /projects/[id], /journeys/[id], upload dialog, session breadcrumbs
- [ ] Tests: unit, integration (local Postgres), worker, Playwright
- [ ] Full suites green; PR opened (not merged)
