# Build status — September 13, 2026

## Accepted media protected from stale upload credentials

New upload completion serializes on the video row and conditionally copies original
and poster blobs to fresh server-owned paths. The source ETag pins checked bytes;
copy status must be successful before the transaction points playback/analysis at
the new paths. The client receives no write SAS for those paths. Identical completion
retries return the accepted record; conflicting metadata and late failure callbacks
cannot change it. Existing accepted rows are not migrated.

Validation passed:

- 180 web tests against local Postgres, including copy preconditions, failed/pending
  copy refusal, size/ETag checks and idempotent completion.
- TypeScript, targeted ESLint and production build.
- Real narrated upload → worker → report → completed seeking: 20.1s (24.7s total).
  After acceptance, the test overwrites the source using its old client SAS,
  verifies the accepted file's SHA-256 still equals the fixture, and verifies a
  forged write using that SAS on the accepted path returns 403.
- Repaired-input recovery using the local harness's trusted storage connection:
  29.4s (54.2s total), including the failed run and successful Retry replacement.

Private local evidence directories under the OS temp folder:
`jams-pipeline-e2e-a3c10f3e-9025-4e92-9bfd-1237663e26e3` (integrity/normal flow) and
`jams-pipeline-e2e-b5a99f75-0e68-4abd-806f-af6d3f425cea` (recovery).
All owned local test services stopped. Luna implemented the blob helper; primary
corrected/verified SDK preconditions and implemented route/tests. Astra reviewed
the production flow with no release-blocking findings.

## Remaining preview work

See `PREVIEW-READINESS.md` and `FINALIZED-MEDIA.md`. Complete deletion must revoke
shares and remove upload sources, accepted copies, derived artifacts and orphaned
copies. Sources currently remain until cleanup, and failed transactions can leave
unused copies. The reservation quota does not measure physical storage. Preserve
durable usage accounting when adding deletion. This is client-write isolation,
not WORM retention against trusted storage operators.

Next bounded task: deletion lifecycle and retryable blob cleanup, with no new
service and no client-provided org identity. Staging deployment, operating-cost
validation and customer invitations remain gated. The known experimental audio
proposal precision failure remains disclosed and unchanged.
