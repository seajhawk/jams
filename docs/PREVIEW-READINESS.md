# Private preview: next five milestones

Updated September 12, 2026. The initial preview should cover narrated recordings,
context switches, transcript, narration sentiment, segmentation and report seeking.
Experimental physical click detection still fails its precision gate and is not
ready for a customer accuracy claim. See `AUDIO-ONSET-DIAGNOSTICS.md` for evidence.

1. **Invite-only admission.** Implemented in this slice: server-configured exact
   Clerk user IDs, checked at the request boundary and before tenant data access or
   personal-org creation. Shared reports also require admission during preview.
   Verify the configured preview with an invited account before staging opens.
2. **Bound usage before accepting work.** Add transactionally enforced aggregate
   storage, analysis allowance and active-run limits. Current per-file limits do
   not cap an organization's total storage or queued work.
3. **Finalize uploads once and delete recordings completely.** Completion currently
   permits repeated metadata updates; upload SAS credentials can overwrite the
   original until expiry. Add immutable finalized media and a deletion lifecycle
   that revokes all related shares and removes original/derived blobs safely.
4. **Build and rehearse staging operations.** `infra/` currently has only a README.
   Prepare the two deployable units, secrets, migrations, health checks, recovery,
   deletion and restore runbooks locally. Provisioning still requires approval.
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
This is one preview control; usage limits and deletion remain separate blockers.
