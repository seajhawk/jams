# Chris's follow-up list

Manual items tracked for when you have time. Claude keeps this current; strike items as you do them.

## Product-blocking eventually, not urgent

- [ ] **Hand-verify transcripts** for `videos/Sample_Amazed then Frustrated.m4a` (and optionally the 2023 mp4) → drop the text into the fixture registry (`worker/tests/fixtures/` registry entries marked `transcript: PENDING_HUMAN`). Unlocks the real-speech WER gate; synthetic espeak gates cover it meanwhile.
- [ ] **Record F10 ground-truth fixtures** (when F10 detection lands, to validate on real footage): 2–3 short screen recordings of yourself doing a small task where you deliberately count clicks/keystrokes (or run the logger script the F10 slice will provide). Synthetic Playwright-generated fixtures carry CI until then.
- [ ] **ADMIN_USER_IDS**: put your Clerk user id in `apps/web/.env.local` to access `/admin` (README §Admin has the one-liner to find your id).

- [ ] **Patent-holder call (concepts provider):** extend the patent's concept-source enum with 'transcript' as a first-class source, or keep transcript as corroborating evidence only? (docs/design/f11-cognitive-effort-providers.md §7.3)
- [ ] **Glossary governance (concepts provider):** ship a default software-domain glossary with JAMS or keep glossaries per-customer config? Materially affects concept recall. (§7.4)

## Deploy-time decisions (no rush — everything runs locally)

- [x] **Azure go/no-go**: **provisioned 2026-09-17** into `rg-jams-staging` (CHarrisTech sub, eastus2) via `az deployment sub create` (azd's own `provision` couldn't run — it demanded a working Docker daemon just to validate the `azure.yaml` service definitions, which isn't installed here; the Bicep templates were already validated offline with `az bicep build` first). Live: storage account `stjamsstagingueva`, Postgres `psql-jams-staging-ueva.postgres.database.azure.com` (empty, no schema yet), ACA environment `cae-jams-staging`, `jams-web` at `jams-web.wittysky-66807383.eastus2.azurecontainerapps.io` (placeholder image), `jams-worker` job (placeholder image). Cost is now accruing (~$17-22/mo estimate). Still open:
  - [x] Postgres firewall: added a temporary single-IP rule (`AllowMigrationClient`) to run migrations, then deleted it immediately after — the standing `AllowAllAzureServices` rule is enough for the deployed containers; nothing outside Azure can reach the server now. Recreate a scoped IP rule the same way for any future out-of-band migration.
  - [x] Drizzle migrations applied (all 12, admin connection) and `jams_web`/`jams_worker` passwords rotated off the migration 0007 hardcoded defaults, 2026-09-17.
  - [x] **Real images deployed 2026-09-18** via `azd pipeline config` (federated OIDC, no long-lived Azure secrets in GitHub) + `azd provision`/`azd deploy` in CI (`.github/workflows/azure-dev.yml`). Registry is GHCR per `azure.yaml`'s `docker.registry`, not an auto-provisioned ACR — keeps PLAN.md's cost decision intact. GHCR PAT (`read:packages`) is set as `GHCR_USERNAME`/`GHCR_TOKEN`.
  - [x] **Full E2E pipeline validated live, 2026-09-18** (upload → SAS → blob finalize → analysis dispatch → KEDA-scaled `jams-worker` execution → real Whisper transcription + context-switch/physical/sentiment providers + scoring → report render → deletion + durable cleanup). Used a real, tiny (8s) trimmed clip from the existing video fixture; driven through the actual client API contract from an authenticated session (Clerk sign-in-token, not a password), not synthetic backend inserts. Unauthenticated access to `/library`, `/api/videos`, `/api/analyses` all correctly return 403.
  - [x] **Two real bugs found and fixed during that test:**
    1. `apps/web/src/db/admin-client.server.ts` (Clerk webhook mirroring, dispatch-outbox reads — needs RLS bypass) reads `DATABASE_URL`, which was never wired into the `jams-web` container — it fell back to a localhost default that doesn't exist in Azure, throwing `ECONNREFUSED` on the very first `POST /api/analyses`. Fixed by giving `jams-web` the `jams_worker` connection as `DATABASE_URL` too (that role already has `BYPASSRLS` + full grants — no fourth Postgres role needed). See `infra/resources.bicep`.
    2. Postgres credentials had drifted from what `azd pipeline config` captured into GitHub secrets vs. what was actually set on the live server (root cause unconfirmed — possibly a different shell context when you ran `azd pipeline config`). Even the **admin** login stopped working. Fixed by regenerating `POSTGRES_ADMIN_PASSWORD`/`JAMS_WEB_DB_PASSWORD`/`JAMS_WORKER_DB_PASSWORD`, setting them identically in both local `azd env` and GitHub secrets, redeploying (Bicep applies the new admin password to the live server), then re-running `ALTER ROLE` for the two app roles. **Worth watching for recurrence** — if `jams_web`/`jams_worker` auth breaks again after a `azd pipeline config` or manual `azd env set`, suspect the same drift.
  - [x] **Added the watchdog scheduler** `docs/OPERATIONS-RUNBOOK.md` assumed existed but never did — nothing was calling `POST /api/admin/watchdog` on a schedule. Found this because two runs from bug #1 above sat stuck as "active" (consuming the preview's `JAMS_PREVIEW_MAX_ACTIVE_RUNS=2` quota) until I called it by hand. Now a trivial `curl`-based Container Apps Job (`jams-watchdog`) runs every 10 minutes.
  - [ ] The ACA-SKU whisper benchmark gate (PLAN.md risk #1) — unbenchmarked at real scale (tonight's test was one 8-second clip, not a throughput benchmark).
  - [ ] Managed identity for Postgres/Storage was explicitly deferred in favor of passwords for this rehearsal (Chris's call, 2026-09-17) — real app-code + migration change, see `infra/readme.md`.
  - [x] Saw a "Fetching 6 files" progress bar during the sentiment stage and briefly suspected a live network fetch; resolved by checking the worker's own logs — the entire run (all providers, including sentiment) completed in 5.2 seconds total, confirming it was just a fast local cache read. No bug.
- [ ] **Clerk production instance**: current keys are a dev instance (strict limits, dev banner). Create the prod instance + point its webhook at the deployed URL when deploying.
- [ ] **F8 billing**: parked per your call ("we don't need stripe"). Revisit when there's a reason to charge.

## Hygiene

- [ ] **Rotate the OpenRouter API key** (it appeared in chat/shell history twice on 2026-07-17): revoke at openrouter.ai → `setx OPENROUTER_API_KEY "<new>"` from a fresh terminal, without pasting it into chat.
- [ ] **Copilot credits reset ~July 31** → reset already happened, but Copilot stays benched a bit longer: burning $94.60 in expiring Claude promo credits (expire 2026-09-19) first, Claude implementing directly. Unbench Copilot once those are spent/expired.
- [ ] **`apps/web/public/demo.mp4`** is gitignored (generated by `pnpm demo:video`); the deploy slice needs a hosted demo asset decision.

## Your uncommitted local experiments (preserved, never touched by delegates)

`CLAUDE.md`, `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`, `apps/web/src/proxy.ts` (`__clerk` matcher), `.gitignore` (`.aider*`), plus `@clerk/ui` in `package.json`/lockfile — commit or discard whenever you decide what you want from them.
