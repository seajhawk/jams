# Recording deletion and retryable storage cleanup

## Implemented: storage writes participate in deletion ordering

The three worker upload helpers acquire a PostgreSQL `FOR KEY SHARE` lock on
their analysis run before touching storage. After acquiring it, the guard checks
the current owner, token, running status and lease against `clock_timestamp()`.
Missing guards or credentials fail closed. A cascading video/run deletion waits
for an admitted upload; a worker cannot start another upload after its run is
deleted. All generated files, including fallback posters, use attempt-specific
paths. Existing database artifact registration remains lease-fenced.

The lock permits lease renewal while storage I/O is in progress. A takeover can
occur during an admitted write: the old attempt can finish its file but cannot
publish it as a current artifact. The main worker uses autocommit for standalone
statements, with explicit transactions around multi-statement writes, so a read
cannot leave an implicit transaction retaining registration locks across later
uploads. Direct provider unit tests inject a no-op guard only with mock storage.

Real PostgreSQL tests cover cascading deletion during upload, concurrent renewal
after earlier artifact registration, stale/deleted/terminal runs, guard absence,
upload exceptions, takeover before registration, and expiry while waiting for a
row lock. CI runs these against the TypeScript-migrated schema; Python creates no
DDL and calls no models.

## Deletion lifecycle requirements (implemented September 13)

1. Record durable tenant-scoped cleanup intent and revoke report/share access in
   one database transaction. Serialize analysis creation and deletion using the
   video row. Preserve consumed analysis allowance after deleting run rows.
2. Capture run IDs and exact storage prefixes before cascading rows. Sweep all
   `videos` container objects under `{orgId}/{videoId}/`, including abandoned
   sources and finalized copies, and `derived` objects under `runs/{runId}/`.
   Older generated posters used `{orgId}/{videoId}/poster.jpg` in `derived` and
   need explicit legacy cleanup too. Derive scope from database records only.
3. Retry idempotent cleanup through existing reconciliation infrastructure, with
   durable attempts and honest pending/failure state. No additional service.
4. Allow for the 15-minute original upload SAS, which can recreate a removed
   source until it expires. Previously minted 60-minute read SAS links are not
   revoked by a database update; deleting the underlying blobs removes access.
5. Handle ambiguous Azure timeouts and process/connection loss. A released DB
   lock does not prove a remote write stopped; a service request may still commit.
   Retain cleanup intent and perform delayed verification/sweeps before declaring
   physical deletion complete. The current lock is an ordering prerequisite, not
   an atomic PostgreSQL/Azure deletion guarantee.

The recording page now offers explicit confirmation naming the recording. DELETE
through `withOrg()` commits cleanup intent and the video/run/report/share cascade
together. A busy worker upload can yield a retryable 409 after a five-second lock
wait; no deletion is accepted until commit. Analysis creation locks the same video
row. Duplicate deletion requests return 202 without duplicating usage or intent.

The retained `recording_deletions` ledger holds run IDs, usage counts, request time,
sweep schedule, attempts, generic errors and lease ownership. Both existing admin
reconciliation and the scheduled watchdog retry due jobs. Deleted analysis counts
remain in the allowance permanently. Original-byte reservations remain until a
post-expiry sweep succeeds; a subsequent sweep failure reserves them again.

An immediate sweep removes accessible objects. Another sweep runs no earlier than
15 minutes after deletion was requested. Successful sweeps then recur daily while
the scheduler runs; errors and abandoned claims retry after five minutes. Each
storage sweep shares a 20-second abort deadline; remaining jobs stay due. Snapshots
and versions are included. A current version is deleted through its base blob first,
then removed as a retained version. `last_verified_at` records the latest successful
post-expiry sweep, not an irrevocable physical-erasure certificate.

Real PostgreSQL tests cover tenant isolation, rollback, concurrent deletion/analysis,
usage transfer, cleanup retries, abandoned claims and stale completion. The browser
journey covers confirmation, inaccessible reports/shares, old playback SAS failure,
snapshot removal, empty source/derived prefixes and retained failed/replacement run
usage. Recreating an old source with its upload SAS, advancing only the isolated
test job's clock, and calling the authenticated watchdog proves delayed cleanup.

Before staging, apply migration `0012_recording_deletion`, configure the existing
watchdog secret/schedule, and alert on cleanup failures or overdue jobs. Operators
can inspect `last_error`, `next_sweep_at` and `last_verified_at` in the ledger.
Provider error strings and SAS URLs are never saved there; recording titles,
transcripts and media contents are not retained in cleanup records.

Staging deployment remains deferred by PLAN. Real Azure versioning and backup/
retention policy still need verification; Azurite tests snapshots, not Azure
versioning. Saved downloads cannot be revoked. Abandoned uploads never explicitly
deleted need a separate retention policy. Reservation limits still do not measure
physical storage.
