# Private preview operations runbook

This runbook describes the first supervised staging rehearsal. It does not
authorize Azure provisioning or customer invitations. Keep all commands scoped to
the intended staging resource group and never paste secret values into logs.

## Preflight

1. Confirm the two image digests are from the same `main` commit and that the
   Container smoke workflow passed. Verify the web image runs as `node` and the
   worker as `jams`.
2. Migrations are applied by the deploy pipeline (`.github/workflows/azure-dev.yml`,
   "Migrate database"), after provision and before the new images deploy, using
   `scripts/ops/migrate-azure-db.sh`. It opens the Postgres firewall to the runner's IP
   only, runs `drizzle-kit migrate` as the admin login, then re-asserts the `jams_web` and
   `jams_worker` passwords from `JAMS_WEB_DB_PASSWORD` / `JAMS_WORKER_DB_PASSWORD`
   (`apps/web/scripts/sync-db-roles.mjs`), and removes the firewall rule on exit. That
   last step replaces the old manual role rotation: migration `0007` creates both roles
   with placeholder passwords, and a fresh server now gets the real ones on its first
   deploy. Azure Postgres keeps point-in-time restore backups (7 days by default), so no
   separate pre-migration dump is needed. The same script runs by hand after `az login`;
   see its header.
3. Configure runtime secrets only in the platform secret store: Clerk secret and
   publishable keys, storage connection/managed identity settings, database URL,
   queue names, `WATCHDOG_SECRET`, and `JAMS_PREVIEW_USER_IDS`. Keep preview IDs
   empty until the invited test account is verified.
4. Set `JAMS_PREVIEW_MAX_STORAGE_BYTES`, `JAMS_PREVIEW_MAX_ANALYSES`, and
   `JAMS_PREVIEW_MAX_ACTIVE_RUNS` to explicit staging values. Use a small quota to
   exercise exhaustion and deletion recovery.

## Smoke rehearsal

Probe `GET /api/health/live` without a Clerk session. Sign in as the invited test
account and upload a short silent fixture and a narrated fixture. Confirm the
upload completes, the worker claims both queue messages, and the report deep-links
to a cut and transcript utterance within the timestamp tolerance. Confirm a second
active run is rejected when the configured active limit is one.

Create a share link, open it in a separate browser context, then delete the
recording from its detail page. Confirm the page returns to the library, the report,
share URL, playback-SAS endpoint, and new-analysis endpoint return 404, and the
database has one `recording_deletions` row containing the captured run IDs.

## Cleanup monitoring

The existing scheduler POSTs `/api/admin/watchdog` every ten minutes with the
machine bearer secret. It marks stale runs, reconciles dispatch intents, and sweeps
due recording deletions. Alert when `cleanup_failed_count` is nonzero, when
`next_sweep_at` is more than 30 minutes overdue, or when a job has repeated failures.

Cleanup is deliberately delayed until at least 15 minutes after deletion to cover
the original upload SAS lifetime. The first sweep may run immediately, but a job is
not considered verified until a post-expiry sweep succeeds. Jobs are retained and
reswept daily to catch storage writes that complete late. Inspect only these safe
fields when debugging:

```sql
select video_id, org_id, attempt_count, next_sweep_at, last_verified_at, last_error
from recording_deletions
where last_verified_at is null or next_sweep_at < now() - interval '30 minutes';
```

Do not save Azure exception objects, SAS URLs, transcript contents, or video paths
outside the storage client logs. A cleanup error is retryable; do not manually
delete the ledger row until the corresponding storage prefixes have been checked.

## Recovery and rollback

If web health fails, stop routing traffic to the new web revision and restore the
previous image digest. If workers fail before claiming runs, restore the previous
worker image and reconcile dispatches. If a worker loses its lease, let watchdog
mark it failed and use the existing admin requeue action; artifact writes are
lease-fenced and attempt-isolated.

If migration fails, stop the rollout, restore the pre-migration database backup,
and do not run application code against a partially migrated database. Migration
`0012` is additive; never edit an applied migration. Investigate failed deletion
jobs through `recording_deletions` and retry the scheduler after storage access is
restored.

## Schema changes

Migrations run before the new code is live, so for a few minutes the old code runs against
the new schema. Every migration must therefore be safe for the code already deployed:

- **Additive changes ship in one push**: new nullable columns, new tables, new indexes, new
  policies that only allow more. Example: `0013` (`videos.archived_at`).
- **Anything the running code cannot tolerate ships in two pushes**: first code that works
  with both the old and new schema, then the migration in a later push. That includes
  dropping or renaming columns, making a column required, and tightening an RLS policy the
  old code relies on. Example: `0014` narrowed the share-link policy; the share page had to
  start setting `app.share_token` before the policy required it.
- Never edit a migration that has been applied anywhere.

If the migrate step fails, the pipeline stops before deploying, so the old code keeps
running against a schema it understands. Fix forward with a new migration, or restore to a
point in time from the Azure portal if data was damaged.

## Exit criteria for supervised preview

Staging is ready for a small invited pilot only after the image smoke workflow,
database migration, two real fixture journeys, deletion/late-upload cleanup,
backup restore rehearsal, scheduler authentication, and cost/latency measurements
all pass. Azure provisioning, customer invitations, and any paid external service
remain explicit approval gates.
