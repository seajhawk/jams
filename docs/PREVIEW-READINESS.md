# Private preview: next five milestones

Updated September 13, 2026. The initial preview should cover narrated recordings,
context switches, transcript, narration sentiment, segmentation and report seeking.
Experimental physical click detection still fails its precision gate and is not
ready for a customer accuracy claim. See `AUDIO-ONSET-DIAGNOSTICS.md` for evidence.

1. **Invite-only admission.** Implemented in this slice: server-configured exact
   Clerk user IDs, checked at the request boundary and before tenant data access or
   personal-org creation. Shared reports also require admission during preview.
   Verify the configured preview with an invited account before staging opens.
2. **Bound usage before accepting work.** Preview admission now serializes org
   reservations and limits declared original bytes, recorded analyses and active
   runs. Storage-side byte enforcement remains open; see the limitations below.
3. **Finalize uploads once and delete recordings completely.** New completions now
   seal original/poster data into server-owned paths and reject metadata changes.
   Deletion now revokes reports/shares and queues retryable cleanup of sources,
   accepted copies, snapshots and derived blobs. See `DELETION-LIFECYCLE.md` for
   tested guarantees and remaining Azure verification.
4. **Build and rehearse staging operations.** The two deployable images, liveness
   check, scheduler, migration, recovery, deletion and restore procedures are
   prepared in `CONTAINERS.md` and `OPERATIONS-RUNBOOK.md`. The first Linux image
   build is a CI gate; Azure provisioning and staging execution still require
   approval.
5. **Validate the initial customer experience.** Run consented real task recordings,
   audit report claims and timing, then—after authorized staging and operating-cost
   checks—conduct supervised pilots. Customer invitations remain unsent.

The real silent and narrated upload → queue → worker → report flows and repaired
input Retry scenario already passed on isolated Postgres and Azurite. Recent CI
is green. These results supersede the old Docker-blocked status in PILOT-RELEASE;
they do not establish that all deployment or customer-readiness gates have passed.

## Preview configuration

Set `JAMS_PREVIEW_USER_IDS` on the **web server**, for example
`user_first,user_second`. Obtain the exact account IDs from the Clerk development
instance for local testing, or the intended instance when preparing staging.
Do not use a public client environment variable. Changing server environment
configuration requires restarting/redeploying the web process.

- Variable absent: existing access rules apply, including anonymous valid shares.
- Variable present but empty: deny all participant access.
- Variable populated: only exact listed user IDs are admitted; org membership and
  platform-admin status do not automatically grant preview admission.

The landing page and authentication entry points remain reachable. Webhooks retain
their signature verification. Watchdog/reconciliation endpoints retain their own
machine-secret or platform-admin authentication and do not require preview admission.
Other admin routes remain behind admission and their existing admin checks.

Enabling this gate does not disable Clerk account registration; it prevents
uninvited accounts from entering the product or obtaining new report/media access.
Already-issued blob SAS URLs retain their existing expiry. Removing a user from
the list therefore blocks new requests, not previously issued storage credentials.
Admission limits and recording deletion complement this control.

## Preview usage admission

With `JAMS_PREVIEW_USER_IDS` present, these server settings apply per organization:

| Setting | Default |
|---|---:|
| `JAMS_PREVIEW_MAX_STORAGE_BYTES` | 10737418240 (10 GiB) |
| `JAMS_PREVIEW_MAX_ANALYSES` | 100 recorded analysis runs |
| `JAMS_PREVIEW_MAX_ACTIVE_RUNS` | 2 queued/running runs |

Overrides must be positive safe integers; invalid configuration rejects new work
with 503. Exhausted limits return 429. These are initial preview operating limits,
not paid-plan entitlements. Counts and inserts share an organization transaction
lock, so concurrent requests cannot each claim the same remaining capacity.

All video rows reserve their declared original size, including incomplete/failed
uploads; unknown legacy sizes reserve the 2 GiB file maximum. All run statuses
count toward the recorded-run allowance, and superseded queued/running work still
counts as active. Rolled-back requests consume no reservation. Deleted run usage
is retained permanently; deleted byte reservations remain until a post-expiry
cleanup sweep succeeds.

This does **not** cap physical Azure storage: posters/derived artifacts are not
counted, and upload SAS permissions cannot enforce the declared file size. Completion
checks original blob size, but oversized or overwritten blobs can exist before that
check. Infrastructure cost controls and staging storage verification remain
required. The active-run check applies to participant admission; trusted operational
recovery remains separately controlled. Removing preview configuration disables
these admission limits along with preview access restrictions.
