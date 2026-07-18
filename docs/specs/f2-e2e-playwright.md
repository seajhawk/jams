# Spec F2-c: Playwright E2E harness (Clerk-authenticated) + F1/F2 golden paths

Goal: the repeatable browser E2E harness from docs/PLAN.md §Verification, local-only for now (real Clerk dev keys in apps/web/.env.local; NOT wired into CI). Branch `f1-foundation`.

## Harness

- Add `@playwright/test` + `@clerk/testing` dev deps in apps/web; `playwright.config.ts` with `webServer: pnpm dev` (reuse if already running), baseURL localhost:3000, chromium only, `pnpm test:e2e` script. Global setup: `clerkSetup()`; per-test `setupClerkTestingToken()`. Create (or reuse if it exists) a dedicated E2E user via Clerk backend API (email jams-e2e-playwright@example.com, password from a generated value stored only in .e2e-user.local.json which you add to .gitignore); sign in through the UI or Clerk testing token flow.
- Prereq services: `docker compose up -d` (postgres + azurite) and migrations applied — do this yourself before running.
- Tiny fixture video: create `fixtures/e2e-tiny.mp4` (<400 KB, few seconds, any resolution) by a reliable means — ffmpeg if available on PATH, else fall back to downloading nothing and instead generating via a pure-JS encoder is NOT required: if you cannot produce a valid mp4, skip the upload spec with test.skip and say so in your summary. Commit the fixture if produced.

## Specs (`apps/web/e2e/`)

1. `demo-report.spec.ts` — signed-in user visits /demo/report: score dial visible, timeline SVG present, clicking a transcript row updates the player time (assert via the media element's currentTime or the playhead position attribute).
2. `upload-library.spec.ts` — golden path: /library → open upload dialog → set the fixture file → title autofilled → create task "E2E Task" inline → upload completes (wait for success toast) → new card visible with duration badge and status uploaded → click card → detail page shows player with src containing a SAS query (`sig=`) and metadata sidebar shows the task name. Then verify server truth: videos row status='uploaded' with correct org scoping (query postgres via docker exec psql) and the original blob exists in Azurite. Use a unique title per run (timestamp arg passed in, not Date.now inside assertions of data you then re-query).
3. Cleanup in afterAll: delete created video rows for this run's unique title; leave the E2E user for reuse.

## Acceptance

- `pnpm test:e2e` passes locally headless (run it; include the output summary). Existing `pnpm test`, `lint`, `build` stay green.
- Commit in logical chunks (harness, fixture, specs); do not push; do not touch CI workflows or the user's uncommitted files (package.json edits for devDeps are fine — but preserve the user's existing @clerk/ui diff, only add).
- Finish: summary + append your row to docs/delegation-log.md (delegate=Codex, model, grade, terse note).
