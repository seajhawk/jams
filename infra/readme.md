# infra/

Bicep templates and `azd` configuration for Azure deployment.

**Coming in a later feature slice (post-MVP).**

Planned resources:
- Azure Container Apps environment
- `jams-web` ACA app (Consumption, min-replicas 0)
- `jams-worker` ACA Job (KEDA azure-queue scaler)
- Azure Storage account (blobs + queues)
- Azure Database for PostgreSQL Flexible Server (B1ms)
- Log Analytics workspace

Local development uses `docker compose` (Postgres + Azurite) from the repo root.
