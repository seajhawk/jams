# Recording deletion: worker prerequisite and remaining work

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

## Still required before customer deletion is available

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

The customer API/UI, cleanup ledger, quota accounting and reconciliation are not
implemented in this slice. Staging deployment remains deferred by PLAN.
