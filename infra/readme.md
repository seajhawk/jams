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

## Scale-out ceilings and usage limits

Every knob below is a Bicep parameter mapped to an azd environment value in
`main.parameters.json` (`azd env set WORKER_MAX_EXECUTIONS 2`, then provision). Defaults are
the values the template shipped with; the ranges are enforced by `@minValue`/`@maxValue` in
`resources.bicep` and sized to the B1ms Postgres budget of 35 user connections
(13 per web replica, about 2 per worker replica). Worst-case spend per day and the reasoning
are in `docs/design/abuse-and-scale-hardening.md`.

| azd value | Default | Range | What it bounds |
|---|---:|---|---|
| `WEB_MIN_REPLICAS` | 0 | 0-1 | Scale to zero, or one warm replica |
| `WEB_MAX_REPLICAS` | 1 | 1-2 | Web compute ($1.30 per replica-day) |
| `WEB_HTTP_CONCURRENCY` | 10 | 1-100 | Requests per replica before scaling out |
| `WORKER_MAX_EXECUTIONS` | 3 | 0-8 | Worker compute ($0.43 per execution-hour); 0 pauses analysis |
| `WORKER_PARALLELISM` | 1 | 1-2 | Replicas per execution |
| `WORKER_REPLICA_TIMEOUT_SECONDS` | 3600 | 600-7200 | Longest single execution |
| `WORKER_POLLING_INTERVAL_SECONDS` | 30 | 10-300 | Queue check interval |
| `WORKER_DRAIN_MODE` | true | true/false | Execution exits when the queue is empty |
| `JAMS_LIMIT_UPLOAD_MAX_BYTES` | 2147483648 | up to 2 GiB | One recording (web and worker) |
| `JAMS_LIMIT_UPLOAD_MAX_DURATION_MS` | 1200000 | | One recording's length (web and worker) |
| `JAMS_LIMIT_ORG_STORAGE_BYTES` | 10737418240 | | Declared bytes per workspace |
| `JAMS_LIMIT_ORG_ACTIVE_ANALYSES` | 5 | | Queued plus running per workspace |
| `JAMS_LIMIT_ORG_ANALYSES_PER_WINDOW` | 50 | | Analyses per workspace per day |
| `JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES` | 30 | | Circuit breaker across all workspaces |
| `JAMS_LIMIT_GLOBAL_UPLOAD_BYTES_PER_DAY` | 214748364800 | | Circuit breaker on new upload bytes |

The remaining knobs (request rates, poster size, stale-upload age, preview limits) are read
from the web app's environment with safe defaults; add them here if they ever need a
non-default value in Azure, because env values set by hand are replaced on the next deploy.
