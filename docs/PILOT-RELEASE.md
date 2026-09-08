# First customer pilot: five next steps

This is an execution companion to PLAN.md, not a claim of release readiness.
Start with a supervised, invite-only pilot. Azure provisioning remains deferred
under the existing plan until explicitly authorized. Do not invite users to upload
customer recordings until the safety and reliability gates below pass.

## 1. Make release checks reproducible

Current work: CI now starts healthy Postgres 16, applies Drizzle migrations before
the web tests, audits npm dependencies, and installs the worker from its lockfile.
The local Docker engine is unavailable, so fresh migration and RLS execution are
not yet verified. A green workflow must be observed before marking this complete.

Next: verify the workflow on a clean runner; extend real-database tests to all
tenant tables and writes; exercise Python against the same migrated database;
add a real upload → queue → worker → report browser gate. Do not count mocked
unit tests or a skipped model test as this evidence.

Exit: fresh migrations, tenant isolation, worker schema compatibility, and the
full media workflow pass with deterministic fixtures and no LLM calls.

## 2. Make each accepted analysis finish coherently

Review existing work branches before implementing duplicate fixes. In particular,
review durable-analysis-dispatch, worker-lease-fencing, media-timebase-contract,
and webhook-recovery-lifecycle work against the September project review.
Merge only after their combined schema and behavior have been tested together.

Acceptance scenarios: receipt before transaction commit; crash after commit;
duplicate delivery; killed owner and lease recovery; stale owner writes rejected;
webhook failure followed by redelivery; delayed audio and nonzero video origins;
incorrect browser duration; failed retry cannot consume prior attempt outputs.
All playback and analysis timestamps must agree within ±250 ms.

Exit: record reproducible commands and observed results for every scenario,
including recovery time. No permanently queued run and no mixed-attempt report.

## 3. Make reports trustworthy enough to act on

Fix coverage and scoring before expanding providers. Unavailable data must not
become a zero measurement or a lower effort score. Report, export, and comparison
must use one explicit scoring basis and compatible coverage. Preserve raw measures
and provider/method versions. Label effort as an experimental proxy and sentiment
as narration sentiment; do not promise validated workload or frustration detection.

Prepare consented recordings with human-marked task boundaries and friction
moments. Include neutral narration, silence, scrolling, delayed audio, and diverse
speaking styles. Separate development recordings from a held-out evaluation set.
Measure timing error, transcription error, false scene-change detections, missed
friction moments, and reviewer corrections. Leave results blank until measured.

Exit: missing-provider tests pass across all report surfaces; identical recordings
do not show improvements caused by weight changes; a human can verify every
claimed issue by seeking to the original evidence.

## 4. Prepare and rehearse a safe private staging release

Build the two planned container units and deployment configuration locally.
Before provisioning: remove fixed production database credentials, establish
identity/secrets handling, pin model artifacts, define migrations and rollback,
and prepare health checks, queue reconciliation, logs, and owner alerts.

Before accepting recordings: enforce invited access, finite storage/analysis and
concurrency limits, immutable finalized uploads, revoked sharing on deletion,
and an executable original/derived-data deletion procedure. State the actual data
destinations and retention behavior; do not publish promises the implementation
cannot meet. Keep optional external labeling disabled.

After authorized staging provision: run the full customer journey and a restore
drill; benchmark the actual worker SKU for throughput, peak memory, temporary disk,
and cost per recording minute. Gate invitations on these results, not a date.

Exit: an invited tester can upload, receive an honest result, seek to evidence,
retry safely, and request deletion; the owner can recover a failure and restore
data. No open signup until abuse and operating-cost controls are demonstrated.

## 5. Recruit five discovery conversations, then three supervised pilots

Buyer hypothesis: a UX researcher or small research agency comparing versions of
the same software task using recordings they already collect. This is a hypothesis
for interviews, not a confirmed market or a reason to build additional features.

Draft invitation (not sent):

> I'm building JAMS to help researchers find task friction in narrated screen
> recordings and verify it through timestamped evidence. Could we spend 20 minutes
> reviewing how you analyze a recent study? I'd like to understand where review
> takes time and what would make a small supervised trial useful to you.

Interview prompts:

- Walk through the last study: who reviewed recordings, with which tools, and for
  how long? What decision did it inform?
- Which part of review is costly or difficult? What evidence was disputed?
- What recording permissions and procurement constraints apply to a trial?
- What would need to improve for you to use this again? Who controls that budget?

Pilot offer draft: one completed task study, a supervised evidence-review session,
and a follow-up on the resulting decision. Agree scope, recording permissions,
retention, support channel, and an explicit price before a paid trial. Price and
terms remain owner decisions; do not invent willingness to pay.

Track per prospect: role, current workflow, baseline review time, agreed success
criterion, permission status, trial date, observed time saved, evidence accepted
or corrected, decision made, return-study request, price discussed, and next step.
Keep identities and private recordings outside this public repository.

Proposed continuation gate: three independent teams complete a study; at least
two request a second study and discuss a concrete paid next step. If the evidence
is weaker, revise the offer before building more analyzers. These counts organize
learning; they are not statistical validation or a revenue forecast.
