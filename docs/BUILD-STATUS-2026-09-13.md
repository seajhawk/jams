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

## Customer deletion and durable cleanup implemented

Recording confirmation now invokes tenant-scoped deletion, revokes reports/shares,
and retains cleanup intent plus consumed usage. Sources, accepted copies, derived
attempts, legacy posters and snapshots/versions are swept. Both manual reconciliation
and the scheduled watchdog retry failures and keep checking for delayed writes.
See `DELETION-LIFECYCLE.md` for the exact limits and operating requirements.

- Full web suite: 204 tests passed, then two added regression tests passed in the
  23-test final focused run. TypeScript and production build passed. ESLint has
  zero errors and one existing ReportHeader navigation warning.
- Real narrated deletion E2E: 29.7s (34.8s total).
- Stronger narrated recovery/deletion E2E: 29.7s (34.3s total), including snapshot
  deletion, all attempt prefixes, revocation, and a late source upload removed
  through the authenticated watchdog. Both consumed run counts survive deletion.
  Evidence: `jams-pipeline-e2e-8e420823-6359-4764-b732-11e5950b4c88` in OS temp.
- Desktop and mobile confirmation screenshots inspected; controls fit both.
- Luna implemented the storage helper and confirmation UI. Astra identified a
  current-version deletion edge case; primary fixed it and added regression coverage.
  Astra's focused rereview found no remaining blocker. Actual Azure versioning still
  requires staging verification.

## Container release preparation implemented

- `apps/web/Dockerfile` builds Next standalone output from the repository root,
  runs as non-root `node`, exposes `/api/health/live`, and has a container health
  check. Its Dockerfile-specific ignore file excludes tests, development files,
  and all `.env*` files.
- `worker/Dockerfile` uses Python 3.12 and locked `uv` dependencies, installs the
  runtime media libraries, runs as non-root `jams`, and preloads static ffmpeg,
  `distil-small.en` Whisper, and the pinned ONNX SST-2 sentiment model. Runtime
  network access is unnecessary after the image build; no LLM or credentials are
  baked into either image.
- `container-smoke.yml` builds both images on Linux, checks non-root identities,
  probes web liveness, verifies no env files entered the image, and loads both
  models with `--network none`. Local Docker image builds remain unrun because
  this host's Docker Desktop engine is unavailable; GitHub CI is the first real
  image build.
- Web focused proxy/liveness tests: 16 passed. Worker runtime preparation and
  sentiment tests: 5 passed. Existing production web build passed after the
  standalone/liveness changes. Astra reviewed the container files and caught the
  missing sentiment preload; the corrected design is ready for CI validation.

Next bounded task: local staging rehearsal and operations runbooks, including
migration, scheduler, backup/restore and cleanup monitoring. Azure provisioning,
operating-cost validation and customer invitations remain gated. The experimental
audio proposal precision failure remains unchanged.
Azure provisioning, operating-cost validation and customer invitations remain
gated. The experimental audio proposal precision failure remains unchanged.
