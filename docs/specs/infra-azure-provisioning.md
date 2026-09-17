# Infra slice: Bicep + azd scaffold for Azure deployment

## Context

JAMS has been built and verified entirely locally (docker compose: Postgres +
Azurite) per `docs/PLAN.md`. Azure provisioning was deliberately deferred until
Chris authorized it — that authorization has now happened. `infra/` currently
contains only a planning `readme.md`; no Bicep or azd configuration exists yet.
Read `docs/PLAN.md` (`## Architecture` and `### Azure resources` sections) and
`docs/OPERATIONS-RUNBOOK.md` (`## Preflight`) before writing anything — they are
the source of truth for exact resource shapes, SKUs, and required environment
variables. Also skim `docs/CONTAINERS.md` for the two Dockerfiles this infra
must deploy (`apps/web/Dockerfile`, `worker/Dockerfile`) and their exposed
health/behavior contracts.

**This is a scaffolding-and-validation task only. Do NOT run `azd up`,
`azd provision` (non-preview), `az deployment ... create`, or any command that
actually creates or modifies real Azure resources. Do NOT run `az login` or
change the active Azure account/subscription. The subscription is already
authenticated (`CHarrisTech`) — leave that alone.** Validate everything with
dry-run/compile-only commands only (see Acceptance below). Chris will review
and trigger the real provisioning run separately.

## What to build

Under `infra/`, using Bicep + Azure Developer CLI (`azd`) conventions
(`azure.yaml` at repo root, `infra/main.bicep` as the entrypoint, modules under
`infra/modules/` or similar — follow standard `azd` scaffold layout so
`azd init`-style tooling recognizes it):

1. **Log Analytics workspace** — comes with the ACA environment; cap ingestion
   per `docs/PLAN.md` (~1 GB/day cap, matches the $0-2/mo target).
2. **Container Apps environment** hosting both units below.
3. **`jams-web`** ACA app: Consumption plan, 0.5 vCPU / 1 GiB, min-replicas 0,
   external ingress on port matching the Dockerfile's exposed port, pulls the
   image built by `apps/web/Dockerfile` from GHCR. Liveness probe against
   `/api/health/live` (see `docs/CONTAINERS.md`).
4. **`jams-worker`** ACA Job (not an app): Consumption, 2 vCPU / 4 GiB,
   `--replica-timeout 3600` (explicit — do not use the 1800s default), KEDA
   `azure-queue` scale trigger on the `analysis-jobs` queue, parallelism 1, max
   3 concurrent executions. Pulls the image built by `worker/Dockerfile`.
5. **Storage account** (StorageV2, LRS, Hot access tier): blob containers
   `videos` and `derived`; queues `analysis-jobs` and `analysis-jobs-poison`;
   a lifecycle management rule moving blobs under `videos/` to Cool tier after
   30 days. No public blob access.
6. **Azure Database for PostgreSQL Flexible Server**, SKU B1ms, with two
   database roles/users `jams_web` and `jams_worker` (the compose-local
   defaults exist in `docker-compose.yml` if present — check it — but
   passwords here must be real, generated, `@secure()` Bicep parameters, never
   hardcoded or committed). Enforce SSL. Firewall/networking scoped to the ACA
   environment's outbound (or VNet integration if that's the simplest correct
   path — your call, document the choice).
7. **Managed identity** (user-assigned, shared by both `jams-web` and
   `jams-worker`) with role assignments: `Storage Blob Data Contributor` and
   `Storage Queue Data Contributor` on the storage account. No storage account
   keys should be needed by the app at runtime — confirm the web app can mint
   user-delegation SAS tokens with just this role (per `docs/PLAN.md`'s
   valet-key SAS pattern); flag in your summary if that's not achievable and a
   different auth model is needed.
8. **GHCR image pull configuration** — both the ACA app and ACA Job need
   registry credentials for `ghcr.io` (assume private images). Wire this as a
   secure parameter (PAT/token), never a literal value in the Bicep files.
9. **`azure.yaml`** at repo root wiring `azd` to build/deploy both services
   from their existing Dockerfiles (no new Dockerfiles — reuse
   `apps/web/Dockerfile` and `worker/Dockerfile` as-is; do not modify them
   unless something is actually broken for deployment, in which case note it
   in your summary instead of silently changing behavior).
10. **Environment variables / secrets wiring** for both units, sourced as
    `@secure()` params / azd env values (never committed with real values):
    `DATABASE_URL` (built from the Postgres outputs + generated password),
    storage account name/queue names (plain, non-secret), `WATCHDOG_SECRET`,
    `JAMS_PREVIEW_USER_IDS` and the three `JAMS_PREVIEW_MAX_*` vars (leave
    unset/empty by default per `docs/OPERATIONS-RUNBOOK.md` step 3 — preview
    IDs stay empty until an invited test account is verified), Clerk secret +
    publishable keys (secure params, no default value, azd will prompt).

**Explicitly do not provision** (per `docs/PLAN.md`'s "Deliberately not
provisioned" list): Azure AI Speech, Azure AI Language, Service Bus, ACR,
CDN/Front Door, Media Services, AKS.

## Constraints

- No secret values (passwords, tokens, connection strings, API keys) anywhere
  in committed files. Use `@secure()` Bicep parameters and azd's env/secret
  handling throughout.
- Default `azd` environment name: `jams-staging`. Default region: `eastus2`
  (override via `azd env set AZURE_LOCATION` — don't hardcode a region with no
  override path).
- Match `docs/PLAN.md`'s named resources/SKUs exactly; if you need to deviate
  (e.g., a SKU is retired, a feature needs a different auth model), say so
  explicitly in your final summary rather than silently substituting.
- Keep `docker compose` (local dev) untouched — this is additive, staging/prod
  infra only.

## Acceptance criteria (all must be dry-run/compile-only — no live resources)

1. `az bicep build` (or `bicep build`) succeeds with no errors on every Bicep
   file.
2. `az deployment group what-if` (or `azd provision --preview` if that flag
   exists in the installed `azd` version — check `azd provision --help`
   first and use whichever real dry-run mechanism the installed CLI supports)
   runs cleanly against the `CHarrisTech` subscription and shows the expected
   resource creation plan with **zero actual resource changes applied**.
3. `git grep` for anything that looks like a real secret/password/key across
   the new files returns nothing.
4. End with a concise summary: what was created, any deviations from
   `docs/PLAN.md` and why, the exact commands Chris should run next to
   actually provision (still not run by you), and anything you could not
   validate without live credentials/resources.

Append one row for this run to `docs/delegation-log.md` (delegate=Copilot,
model from your session, grade ✅/⚠️/❌ per that file's legend, terse note)
without rewriting the file.
