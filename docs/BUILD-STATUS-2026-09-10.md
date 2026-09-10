# JAMS build status — 2026-09-10

This is an inventory of `codex/jem-validation`, updated September 10.
The previously unfinished timestamp merge is resolved, preserving worker
lease fencing and attempt-specific artifacts. It is integrated with the JEM
evaluation branch in `57d18d1`. This is engineering progress, not a release claim.

## Implemented capability

- The web app has an org-scoped library, task grouping, direct Blob SAS upload,
  video playback, analysis status polling, partial-run reporting, report
  timelines/transcripts, adjustable effort-score weights, comparison, sharing,
  and CSV/JSON export. Relevant surfaces are under
  `apps/web/src/app/`, `apps/web/src/components/`, and `apps/web/src/lib/`.
- The worker pipeline includes probe/CFR normalization, context switches,
  transcription, narration sentiment, segmentation, scoring, and optional
  segment labeling under `worker/src/jams_worker/providers/`.
- Physical providers are implemented and registered in `worker/src/jams_worker/main.py`:
  `ClicksProvider`, `KeypressesProvider`, and `ScrollsProvider`. They emit
  canonical `physical` measures (`clicks`, `keypresses`, and `scrolls`) with
  confidence and provider metadata. They are experimental and have not been
  scored by the current context-switch-only JEM evaluator; the evaluation
  matrix records this explicitly.
- Durable analysis dispatch, worker leases/fencing, retry/poison handling,
  watchdog/reconciliation, and admin recovery code are present in the current
  main lineage. Their combined behavior still needs integrated evidence.

## Verified evaluation evidence

- The JEM harness now enforces CFR normalization, start/end flash anchors,
  drift bounds, ordered one-to-one matching, and reproducible detector
  parameters: `worker/src/jams_worker/jem_eval.py` and
  `worker/src/jams_worker/providers/context_switch.py`.
- Controlled-journey adaptive detection recorded 8 TP / 0 FP / 2 FN (F1
  0.8889). IANA and Outlook real recordings remain failing baselines at F1
  0.0. The low-floor variant reached F1 1.0 on the controlled fixture but
  introduced IANA false positives and is not the production default:
  `docs/JEM-HILLCLIMB-2026-09-09.md`.
- The JEM report says explicitly that upload, database processing, and report
  rendering were not exercised by that provider evaluation:
  `docs/controlled-journeys-eval.md`.
- The integrated timestamp work includes a real MPEG-TS regression for a
  shared transport-clock origin and a word-end bounds regression. Both pass;
  MP4 edit-list playback behavior still needs a browser-based check.
- The JEM evaluator now records expected/detected counts, mean/p95/max timing
  error, and false positives per minute over the union of scored windows.
  Its Python API validates complete parameters before media reads.
- Dependency overrides now apply at workspace root. Frozen installation,
  dependency audit (zero advisories), Vally static validation, and web build
  passed. Web tests: 102 passed, 4 database tests skipped locally.

## Release blockers and evidence gaps

- Docker's engine is unavailable locally. CI failures from the conflicting
  pnpm version, outdated lease-claim mocks, and stale nested web lockfile are
  fixed. The workspace root lockfile is now the only web install/audit source.
  GitHub run `34524516899` at `f35f9b4` passed both jobs: 106 web tests and
  147 worker tests (15 skipped), plus fresh Postgres migrations, dependency
  audit, and web build.
  This does not establish an upload-to-worker-to-report integration pass.
- The full local worker run exposed a narrated-click precision failure
  (0.04545 versus the pinned 0.85 gate). The run recorded 133 passes and
  3 skips. A scoped rerun confirmed 6 true positives, 126 false positives,
  and 0 false negatives at the unchanged 75 ms tolerance. This is raw audio
  proposal precision before the click provider's visual verification, not
  final report precision. Both stages need separate evaluation. A proposed
  speech-threshold change still failed and was reverted; the gate remains.
- There is no reproducible real upload → queue → worker → report browser gate.
- The recovery matrix remains unobserved end to end: transaction/queue crash
  windows, duplicate delivery, lease recovery, stale-owner fencing, webhook
  redelivery, delayed audio/nonzero origins, incorrect browser duration, and
  mixed-attempt prevention.
- Missing-provider semantics, held-out human labels, sentiment and
  segmentation quality, effort-score validity, and physical-provider metrics
  are not release evidence. Missing data must not silently become zero effort.
- The target ACA worker benchmark, private staging run, deletion/retention
  procedure, invite gating, quotas/concurrency limits, share revocation, and
  restore drill remain outstanding.

## Next five tasks

1. Finish reliability integration: the timestamp work is integrated; webhook
   recovery remains on its separate branch. Run the full recovery matrix.
2. Extend CI evidence beyond the repaired web workflow: verify worker schema
   compatibility against the migrated database and exercise optional media
   fixtures. Report skipped tests explicitly; no model calls belong in CI.
3. Add and pass the real upload → queue → worker → report browser gate against
   the migrated local stack.
4. Build held-out labels and dedicated evaluations for physical events,
   narration sentiment, segmentation, missing-signal behavior, and score
   stability; keep current JEM results diagnostic.
5. Rehearse private staging controls and benchmark the actual worker SKU before
   any pilot invitation: access, quotas, deletion/retention, share revocation,
   recovery, restore, runtime, memory, disk, and cost.

The application is not release-ready and should not accept pilot recordings
until those gates have reproducible evidence.

## Review and delegation

Luna handled the inventory, JEM metrics, and workspace dependency repairs.
Astra reviewed the integrated timestamp changes and found two defects, both
fixed with regressions. Its requested final rereview could not run because of
the usage limit; that review remains outstanding. A bounded Copilot diagnosis
did not produce a passing click improvement and was reverted. See
`docs/delegation-log.md` for outcomes.
