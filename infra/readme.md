# infra/

Bicep templates and `azd` configuration for Azure deployment.

**Scaffolded and provisioned 2026-09-17** into `rg-jams-staging` (CHarrisTech
subscription, eastus2). `azd provision` itself could not run — the installed
azd (1.28.0) demands a working Docker daemon just to validate `azure.yaml`'s
service definitions, which isn't installed here — so the deployment was run
directly with `az deployment sub create --template-file infra/main.bicep`
against a resolved copy of `main.parameters.json` (azd env values substituted
in locally, never committed). The Bicep itself was validated offline first
with `az bicep build`. See `docs/CHRIS-TODO.md` for what's still open
(migrations, password rotation, real container images).

## Layout

- `azure.yaml` (repo root) — `azd` service definitions for `web`
  (`apps/web/Dockerfile`) and `worker` (`worker/Dockerfile`).
- `main.bicep` — subscription-scope entrypoint; creates the resource group
  (`rg-<environmentName>`) and calls `resources.bicep`.
- `resources.bicep` — everything else, resource-group scoped:
  Log Analytics workspace, Container Apps environment, `jams-web` Container
  App, `jams-worker` Container Apps Job (KEDA `azure-queue` trigger on
  `analysis-jobs`), Storage account (`videos`/`derived` containers,
  `analysis-jobs`/`analysis-jobs-poison` queues, 30-day cool-tier lifecycle
  rule), PostgreSQL Flexible Server B1ms + `jams` database.
- `main.parameters.json` — maps Bicep params to azd environment variables.

## What this does NOT do yet

- **Does not provision anything.** No `azd up`/`azd provision`/
  `az deployment ... create` has been run. Validate with
  `az bicep build --file main.bicep` (offline, safe) before ever running a
  live command.
- **Does not rotate the `jams_web`/`jams_worker` Postgres role passwords.**
  Migration `0007_postgres_rls.sql` creates those roles with hardcoded
  placeholder passwords (`jams_web`/`jams_worker`, matching the local
  compose defaults). This template generates real passwords as secure
  parameters and wires them into the container `DATABASE_URL`/
  `DATABASE_URL_WEB` secrets, but **something must run
  `ALTER ROLE jams_web PASSWORD '<value>'` / `ALTER ROLE jams_worker
  PASSWORD '<value>'` against the server after the first migration**, using
  the admin login, before those containers can actually connect. See the
  rotation step added to `docs/OPERATIONS-RUNBOOK.md`.
- **Uses account-key storage auth and password-based Postgres roles, not
  managed identity.** The current app code (`apps/web/src/lib/blob.ts`,
  `apps/web/src/lib/queue.ts`, `apps/web/src/db/client.ts`,
  `worker/src/jams_worker/settings.py`) authenticates via
  `AZURE_STORAGE_CONNECTION_STRING` (shared key) and plain
  `postgresql://user:password@host/db` strings — no AAD token support
  exists anywhere in the app today. Decision (Chris, 2026-09-17): ship this
  rehearsal on passwords, which match the shipped/tested code; track
  managed identity as a real follow-up feature slice, not a Bicep-only
  change, since it needs: AAD auth enabled on the Flexible Server plus
  AAD-mapped Postgres roles (migration change, not just `ALTER ROLE`), a
  token-refresh callback in both the web app's and worker's DB clients
  (AAD tokens expire hourly), user-delegation SAS in `blob.ts`/`queue.ts`
  instead of shared-key SAS, and a local-dev password fallback since
  Azurite/local Postgres have no managed-identity concept. Group with the
  VNet/Private Link hardening item below.
- **No VNet/Private Link.** The Postgres firewall allows all Azure services
  (`0.0.0.0`–`0.0.0.0` rule) rather than being network-isolated. Fine for a
  supervised staging rehearsal; tighten before real customer data per
  `docs/OPERATIONS-RUNBOOK.md`.
- **`azd deploy worker` support for Container Apps Jobs is unverified** on
  the installed azd version (1.28.0). If `azd` can't update a Job's image,
  fall back to `az containerapp job update --image <ref> --resource-group
  rg-<env> --name jams-worker`.

## Estimated monthly cost (list price, before any Azure sponsorship credit)

| Resource | Estimate |
|---|---:|
| PostgreSQL Flexible Server B1ms (compute) | ~$12.40/mo |
| PostgreSQL storage, 32 GiB | ~$3.70/mo |
| Storage account (Hot, LRS) at light preview volume | ~$1–3/mo |
| Log Analytics, 1 GB/day cap | ~$0–3/mo |
| Container Apps environment + `jams-web` (min-replicas 0) | within free monthly grant at low traffic |
| Container Apps Job `jams-worker` (Consumption) | pay-per-execution, small at preview volume |
| **Total** | **~$17–22/mo** |

Per `docs/PLAN.md`, Postgres and other Azure spend are expected to land on
Azure sponsorship credits, not cash — but this is close enough to the
explicit $20/mo check-in threshold that it should be confirmed before
running `azd provision`, not assumed.
