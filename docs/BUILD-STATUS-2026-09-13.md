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

Worker deletion prerequisite completed after the media-integrity change:

- All derived uploads now check the active lease and hold a deletion-blocking
  row lock during storage I/O. Renewal remains possible during slow uploads.
- Worker autocommit prevents implicit reads retaining stronger registration
  locks. Generated posters now use attempt-specific paths.
- 67 focused worker tests passed, 3 optional model tests skipped; Ruff passed.
  PostgreSQL integration tests are included in CI using the migrated schema.
- Narrated recovery E2E passed with the final locking/transaction changes: 26.1s
  (30.5s total). Evidence: `jams-pipeline-e2e-92101607-d4ed-4d05-8150-18d78847d557`.
- Earlier broad worker run: 195 passed, 8 skipped, one known experimental audio
  proposal gate failed (TP 6, FP 126, FN 0; precision 0.04545 vs 0.85).
- Luna implemented the initial guard. Astra caught renewal blocking; primary
  revised locking, transaction boundaries and poster isolation. Astra reviewed
  the revision with no remaining prerequisite blocker. All owned services stopped.

See `DELETION-LIFECYCLE.md` for the bounded guarantee and remaining API/cleanup
work, including ambiguous remote writes and upload-SAS expiry.

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
