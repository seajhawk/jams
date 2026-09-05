# JAMS project review — September 5, 2026

Reviewed commit: `79dfa13d54a17b2dec6d63d772b531886f651022`. The working tree was clean at the start. This review adds documentation and an executable diagnostic; it does not change application behavior or the approved plan.

**Assessment: a substantial working prototype with a sensible architecture, but not ready for an unattended paid launch.** The most consequential gaps are trustworthy measurement, preservation of timestamps, reliable background processing, and evidence that a specific buyer will repeatedly pay for the result. More feature breadth is currently less valuable than closing those gaps.

This is a repository and local execution review, not a certification, penetration test, production load test, patent opinion, or forecast of commercial success. No Azure resources were provisioned. No paid LLM calls were made. Customer interviews, actual patent claims, production configuration, live CI history, and business traction were not available to verify.

## What is worth preserving

- Two deployable units, one canonical measures table, and TypeScript ownership of migrations keep operational and implementation complexity manageable.
- Tenant identity comes from Clerk through `withOrg()`. Parameterized queries, explicit org filters, and transaction-local RLS context provide useful layers of protection.
- The provider structure, timestamped evidence, downloadable measures, comparison workflow, and immediate weight adjustment form a coherent product.
- Share tokens have strong randomness, Clerk signatures are verified, and optional labeling is off by default with an explicit CI block.
- There are real tests and useful synthetic fixtures. The three opt-in Whisper tests passed when actually enabled on this machine.

These strengths justify improving the existing system. I found no reason to replace the architecture or add another service.

## Verification and its limits

| Check | Observed result |
|---|---|
| `pnpm build`, web | Passed compilation, TypeScript, and page generation; local `.env.local` was loaded. This does not prove clean CI or deployment configuration. |
| `pnpm lint`, web | Passed. |
| `pnpm test`, web | 19 suites passed, 85 tests passed. RLS integration suite failed to connect to local Postgres; its two tests did not execute. |
| `uv run pytest`, worker | 92 passed; three Whisper tests skipped by default. |
| `JAMS_RUN_WHISPER_TESTS=1 uv run pytest tests/test_transcription.py -m whisper_model -v` | All three passed with cached models and eSpeak NG. |
| `uv run ruff check`, worker | Passed. |
| Additional worker diagnostics | Reproduced missing-data scoring, no-audio success, ignored flags, stale metadata, and retained prior-provider results. |
| Real ffmpeg diagnostic | Reproduced loss of the original audio start offset. |
| Actual cached ONNX model, offline | Reproduced strong sentiment predictions for neutral task narration. |
| `pnpm audit --prod --json` | Reported 23 high, 22 moderate, one low, zero critical findings. These are dependency audit counts, not 46 demonstrated exploitable application defects. |

Docker's Linux engine was initially unavailable; attempts to start/query Docker Desktop did not yield a usable engine during verification. Pending CLI checks were interrupted. I did not execute browser E2E tests or real database concurrency/isolation experiments. No claim below treats those as passed. Existing browser report tests seed completed runs directly, so even a successful run of them would not prove the complete upload → queue → worker → report path.

Reproduce the additional diagnostics from `worker/`:

```powershell
uv run python ../docs/reviews/2026-09-05-worker-repro.py
uv run python ../docs/reviews/2026-09-05-worker-repro.py --media --sentiment
```

The second command uses ffmpeg and the cached sentiment model, with model networking disabled. These diagnostics intentionally print observed defects; they are not desired-behavior regression tests.

## Findings requiring attention before external reliance

P1 means fix before depending on the affected behavior with customers. P2 means a material limitation or hardening task. Evidence is labeled as executed or established by source inspection; speculative exploits are not presented as confirmed.

### 1. [P1] Audio extraction loses the video's time origin

**Executed with real ffmpeg and the actual probe provider.** A synthetic six-second MP4 contained a tone starting around two seconds into the video. The original audio stream started at 1.936 s; the extracted WAV's tone started at 0.064 s. The normalized MP4 still retained a delayed audio stream. Transcript timestamps derived from that WAV therefore cannot be applied directly to the video timeline: they are about 1.94 seconds early, far outside ±250 ms.

The probe extracts WAV from the original, independently of normalization. Report playback also uses the original blob. Merely making frames CFR does not solve stream offsets.

Evidence: [probe.py](/D:/git/jams/worker/src/jams_worker/providers/probe.py:260), [report-assembly.ts](/D:/git/jams/apps/web/src/lib/report-assembly.ts:276).

**Fix and acceptance:** define one media time origin, preserve offsets with padding/trimming or an explicit timestamp mapping, and derive every stage from that contract. Test delayed audio, nonzero starts, VFR, discontinuities, and end-of-recording seeks through the actual probe → transcription → report path. Extracting from the normalized file alone is insufficient unless its stream offsets are also handled.

### 2. [P1] Queue publication races the database commit

**Source-confirmed ordering defect; live race not executed.** `POST /api/analyses` publishes the queue message inside `withOrg()`'s transaction. A fast worker can receive it while the inserted run is invisible. A missing run produces `skipped`, and the handler deletes the message. The transaction can then commit a permanently queued run. The watchdog only considers running runs, so it does not recover this case.

Evidence: [analysis route](/D:/git/jams/apps/web/src/app/api/analyses/route.ts:73), [with-org.ts](/D:/git/jams/apps/web/src/lib/with-org.ts:100), [main.py](/D:/git/jams/worker/src/jams_worker/main.py:65), [admin-runs.ts](/D:/git/jams/apps/web/src/lib/admin-runs.ts:31).

**Fix and acceptance:** use durable dispatch intent plus reconciliation, such as an outbox within the existing two units. Moving enqueue after commit helps visibility but still leaves a crash window; it is not a complete fix. Test worker receipt before commit, crash after commit/before send, duplicate sends, and a missing run without destructive acknowledgement.

### 3. [P1] Run claims do not exclude another active worker

**Source-confirmed.** `claim()` skips only `succeeded`; it allows another claim for `running`, `partial`, or `failed`. Its row lock ends after claiming. Queue visibility is fixed at 45 minutes with no renewal, while the planned job timeout is 60 minutes. Duplicate delivery or an admin requeue can cause simultaneous writes to the same run. Delete/insert idempotency does not serialize whole pipelines.

Evidence: [db.py](/D:/git/jams/worker/src/jams_worker/db.py:39), [main.py](/D:/git/jams/worker/src/jams_worker/main.py:34), [admin-runs.ts](/D:/git/jams/apps/web/src/lib/admin-runs.ts:68).

**Fix and acceptance:** atomically claim with an owner/lease and fence subsequent writes; renew visibility; distinguish retries from terminal runs. Two real connections and duplicate queue messages must result in one owner. Kill that owner and demonstrate bounded recovery. Permanent `too_long`/`corrupt_file` errors should fail promptly instead of waiting through repeated 45-minute visibility intervals.

### 4. [P1] Webhook reservation can permanently suppress unfinished work

**Source-confirmed.** The idempotency ledger insert commits before user/org updates and external org creation finish. If a subsequent step fails, redelivery hits the existing event and returns `duplicate` even though `processed_at` is null. Account setup or deletion handling may remain unfinished indefinitely.

Evidence: [mirror-store.ts](/D:/git/jams/apps/web/src/lib/clerk/mirror-store.ts:22), [webhook.ts](/D:/git/jams/apps/web/src/lib/clerk/webhook.ts:86).

**Fix and acceptance:** distinguish pending, processing, completed, and failed events; make retryable steps idempotent. Complete DB-only changes and ledger state atomically where possible. External Clerk operations need their own reconciliation. Inject a failure after reservation and after org creation, redeliver, and verify one completed setup. Also test concurrent first sign-ins, since personal-org creation currently has a list-then-create race.

### 5. [P1] Missing analysis data is reported as low effort

**Executed.** The diagnostic scored a one-minute example at 62 with measures and 1 with all measures absent. Normalization still supplies zero-valued components and the denominator still includes their weights. This rewards missing information. Separately, `skipped_no_audio` does not count as partial in `run_pipeline`, so a video without narration can finish as `succeeded` when the other providers complete.

Evidence: [effort-score.ts](/D:/git/jams/apps/web/src/lib/effort-score.ts:155), [pipeline.py](/D:/git/jams/worker/src/jams_worker/pipeline.py:242), [transcription.py](/D:/git/jams/worker/src/jams_worker/providers/transcription.py:611).

**Fix and acceptance:** represent unavailable measurements separately from observed zero. Show availability and reasons; either withhold a composite score or label its reduced basis explicitly. Do not compare complete and incomplete runs as ordinary improvement deltas. Test no audio, silence, disabled providers, and individual provider failures throughout worker, API, UI, export, and comparison.

### 6. [P1] The effort and sentiment scales need validation before strong claims

**Executed and source-confirmed.** Scaling constants explicitly aim to make the demo readable. Speech saturates the physical component at approximately 40.5 words/minute; both 41 and 120 words/minute scored 100. Context switches saturate at about 2.72/minute. Neither threshold has a documented validation basis in the reviewed material. Narration rate is particularly sensitive to instructions and speaking style.

The actual ONNX model returned:

| Input | Sentiment | Model confidence |
|---|---:|---:|
| I clicked the blue button. | −0.6781 | 0.8390 |
| The window is open. | +0.9965 | 0.9982 |
| I am entering the account number. | −0.9666 | 0.9833 |

These small examples establish a failure mode, not a population accuracy estimate. A binary sentiment classifier's probability is not a validated confidence estimate for frustration or task difficulty. The model card itself calls for use-case-specific evaluation and documents biased predictions. [Model card](https://huggingface.co/distilbert/distilbert-base-uncased-finetuned-sst-2-english).

Evidence: [effort-score.ts](/D:/git/jams/apps/web/src/lib/effort-score.ts:46), [sentiment.py](/D:/git/jams/worker/src/jams_worker/providers/sentiment.py:159), [EffortScoreDial.tsx](/D:/git/jams/apps/web/src/components/report/EffortScoreDial.tsx:72).

**Fix and acceptance:** label these as experimental observable proxies, preserve raw values, and publish the method/version and coverage. Validate against independently annotated real task recordings, participant feedback, and observed success/errors/time. NASA-TLX is one possible convergent measure, not ground truth; its six workload dimensions illustrate why a single observable proxy is insufficient. [NASA TLX](https://software.nasa.gov/software/ARC-15150-1A). Evaluate scene-change precision/recall separately from actual task/context changes and report performance by recording condition. Add a real neutral-narration sentiment fixture before promoting sentiment into a high-weight decision signal.

### 7. [P1] Changing weights makes reports and comparisons disagree

**Source-confirmed.** Weight-profile PATCH mutates the existing profile. Report assembly pairs that current profile with an older stored score. The report header/Score tab recompute using current weights, while comparisons and JSON exports use the stored score. Identical recordings processed before and after a profile change can appear to differ solely because scoring settings changed.

Evidence: [profile PATCH](/D:/git/jams/apps/web/src/app/api/weight-profiles/[id]/route.ts:58), [report-assembly.ts](/D:/git/jams/apps/web/src/lib/report-assembly.ts:312), [ReportHeader.tsx](/D:/git/jams/apps/web/src/components/report/ReportHeader.tsx:41), [compare.ts](/D:/git/jams/apps/web/src/lib/compare.ts:94).

**Fix and acceptance:** make profile/formula versions immutable for historical snapshots, or explicitly recompute both sides using one selected version and label that choice. Check provider versions and data availability too. Test identical measures with a profile edit between runs: header, score tab, exported JSON, and comparison must agree.

### 8. [P2] Accepted analysis configuration is not honored

**Executed.** `{sentiment: {enabled: false, fallback: 'vader'}}` still calls the ONNX classifier and emits sentiment. Disabled segmentation still invokes the builder and writer. The web schema exposes `fallback`; the worker reads `method`, which the strict web schema rejects. Extra segmentation cues and context-detector selection do have implementation support, so the problem is specific settings, not the entire configuration feature.

Evidence: [analysis-config.ts](/D:/git/jams/apps/web/src/lib/analysis-config.ts:34), [sentiment.py](/D:/git/jams/worker/src/jams_worker/providers/sentiment.py:57), [segmentation.py](/D:/git/jams/worker/src/jams_worker/providers/segmentation.py:335).

**Fix and acceptance:** share a versioned config contract across languages; resolve enabled providers and dependencies centrally; implement or reject each advertised setting. Test from API-validated JSON through the actual worker dispatch, including fallback on ONNX failure.

### 9. [P1] Corrected probe metadata does not reach downstream providers

**Executed with a DB stub.** The run snapshot contains browser-provided duration. Probe updates Postgres but does not refresh `context.run`. Transcription and segmentation prefer the stale snapshot. A claimed duration of 1,000 ms remained their duration even when the DB stub returned a corrected 60,000 ms. The resulting transcript may fail duration checks; segment bounds can be wrong. Scoring reads fresh DB duration, creating further inconsistency.

Evidence: [probe.py](/D:/git/jams/worker/src/jams_worker/providers/probe.py:203), [transcription.py](/D:/git/jams/worker/src/jams_worker/providers/transcription.py:494), [segmentation.py](/D:/git/jams/worker/src/jams_worker/providers/segmentation.py:72).

**Fix and acceptance:** populate an authoritative post-probe media object and use it throughout. Deliberately incorrect upload metadata must not affect final timestamps, segments, scores, or status after a successful probe.

### 10. [P1] Partial retries can mix old and new provider results

**Executed with patched persistence.** If a retried provider throws before returning rows, `write_provider_measures()` is not called and prior rows remain. The pipeline continues, so later stages can consume old output alongside newly generated data. Broad `partial` handling does not isolate attempts. Artifacts such as normalized video/audio are also stored under video-scoped paths and overwritten across runs.

Evidence: [pipeline.py](/D:/git/jams/worker/src/jams_worker/pipeline.py:207), [probe.py](/D:/git/jams/worker/src/jams_worker/providers/probe.py:257).

**Fix and acceptance:** publish coherent attempt outputs atomically or explicitly invalidate failed provider output and dependent stages. Use immutable run/attempt artifact paths where historical reproducibility matters. Retry after changed input/config with an injected failure and verify no old result is silently treated as new.

### 11. [P1 before relying on RLS] Share tokens are globally readable by the web DB role

**Source-confirmed database-policy exception; no HTTP cross-tenant exploit demonstrated.** `share_links_token_select` grants `USING (true)` for SELECT to `jams_web`, alongside the tenant policy. This permits the role to enumerate every tenant's plaintext bearer token. The actual shared-page lookup correctly filters the supplied token, but the database no longer protects this table against an omitted filter. Existing RLS tests exercise only videos and measures.

Evidence: [RLS migration](/D:/git/jams/apps/web/src/db/migrations/0007_postgres_rls.sql:148), [shared page](/D:/git/jams/apps/web/src/app/share/[token]/page.tsx:32).

**Fix and acceptance:** remove unrestricted selection and introduce a narrowly constrained token lookup; consider storing token hashes. Under the ordinary web role, unscoped selection must not return other tenants' links. A valid supplied token must still resolve only its intended report. Extend real-DB isolation tests to every tenant table and to writes, not just two SELECT cases.

### 12. [P1] Organization deletion does not disable existing shared access

**Source-confirmed.** Organization deletion only sets `orgs.deleted_at`. The public shared-page lookup and report assembly do not check that tombstone; neither revokes links. An unexpired shared link can therefore continue minting playback access for a deleted organization's retained data.

Evidence: [mirror-store.ts](/D:/git/jams/apps/web/src/lib/clerk/mirror-store.ts:82), [shared page](/D:/git/jams/apps/web/src/app/share/[token]/page.tsx:32), [report-assembly.ts](/D:/git/jams/apps/web/src/lib/report-assembly.ts:234).

**Fix and acceptance:** define deletion semantics, revoke sharing and deny fresh access immediately, then process retention/purge reliably. A real deletion webhook followed by a fresh public request must fail. Existing read SAS URLs can remain valid for their issued lifetime; communicate that boundary accurately. No user-facing video deletion or original/derived-blob purge lifecycle was found in the implementation.

### 13. [P1 launch gate] CI does not enforce the promised integration contract

**Source-confirmed and partly reproduced.** Web CI has no Postgres service or migration step, yet `pnpm test` includes an unconditional Postgres suite. Worker DB tests use mocks, not Drizzle-generated schema. CI does not enable the real Whisper gates, provision their prerequisites, run the actual worker container, or run browser E2E tests. Sentiment tests cover row construction and VADER, not the production ONNX model. The synthetic WER gate is 8%, while PLAN.md promises less than 5%.

Evidence: [CI workflow](/D:/git/jams/.github/workflows/ci.yml), [RLS test](/D:/git/jams/apps/web/src/__tests__/rls.integration.test.ts:9), [worker DB test](/D:/git/jams/worker/tests/test_db.py), [fixtures](/D:/git/jams/worker/scripts/make_fixtures.py:419).

**Fix and acceptance:** make clean CI boot ephemeral Postgres/Azurite, migrate from scratch, verify all DB roles, and exercise Python against that schema. Run cached deterministic model gates in a required job with no LLM network access. Add a real upload → queue → worker → report test, delayed-audio/VFR fixtures, and an independently labeled real-recording holdout. Document any justified changes to accuracy thresholds instead of silently relaxing the plan.

## Additional launch and product risks

**Unbounded usage and upload integrity — P1 before public signup.** The API caps declared video size, but there is no per-org storage/analysis quota, rate limit, active-run cap, or reservation ledger. Blob write SAS does not enforce the declared byte size; completion catches a mismatch after storage has already been consumed. Its write permission also permits replacing the original until expiry, after completion or analysis. There is no ETag/version pinning in worker download. Failed/abandoned uploads have no cleanup path. Add admission limits, byte reconciliation, immutable finalized input, and cleanup. Test repeated reanalysis, oversize direct uploads, post-completion overwrite, and cancellation. Deferred Stripe billing need not block an invite-only pilot, but finite usage limits should not wait for billing.

**Dependency maintenance — P1 launch gate, exploitability still to triage.** Next.js is pinned to 16.2.10. The registry audit lists fixes at 16.2.11 for several advisories. Two checked primary advisories require specific configurations: single-locale i18n for proxy bypass, and at least one Server Action for the cited DoS. Neither precondition was found in the application source/config, so this review does not claim those exploits work here. Upgrade to an appropriate maintained patched release and rerun checks. Much of the additional audit surface comes through the `shadcn` CLI being a production dependency; separate build tooling from deployed runtime and triage reachable code. [Proxy advisory](https://github.com/vercel/next.js/security/advisories/GHSA-6gpp-xcg3-4w24), [DoS advisory](https://github.com/vercel/next.js/security/advisories/GHSA-m99w-x7hq-7vfj).

**Deployment is a real remaining milestone.** `infra/` is a placeholder; no Dockerfiles, Bicep, or image/deploy workflow were found. Next config does not enable the planned standalone output. Storage clients require account-key connection strings rather than managed identity. Models download on demand rather than being baked into a worker image. The watchdog requires an interactive Clerk admin session and has no scheduled workflow. Migration 0007 creates fixed-password logins, including an RLS-bypassing worker; isolate local bootstrap credentials from production provisioning. Rehearse migrations and trusted admin access on the actual managed Postgres role model: Azure's administrator is not an unrestricted superuser. [Azure role documentation](https://learn.microsoft.com/en-us/azure/postgresql/security/security-access-control).

Respect the existing decision to defer Azure provisioning. Prepare images, infrastructure, migration/rollback procedures, backup/restore tests, observability, and a machine-authenticated watchdog locally first. The actual 2-vCPU/4-GiB benchmark remains a separate authorized deployment gate. A 2-GiB original plus full-resolution normalized video, audio, and thumbnails also needs measured temporary-disk and memory limits, not just a duration cap.

**Comparison semantics — P2.** Segment alignment is positional, not semantic, and report assembly does not order the segment SELECT. Missing or extra early segments can pair different actions. Sort deterministically, expose approximate alignment, and add manual matching or explicit unmatched segments. Do not frame one participant's lower score as proof that a design is better. Control task, instructions, participant differences, provider versions, and coverage.

**Review-session usability — P2.** Moving a weight to zero removes it from `liveScore.breakdown`, which also renders the sliders; it disappears until reset. Playback SAS has no refresh path after an hour. Comparison seeks rely on a 100-ms delay rather than media readiness. Poster PUT does not check HTTP success. Prioritize these when running the real browser acceptance flow; no visual/accessibility audit was performed in this review.

**Export durability — P2.** JSON export includes a temporary playback URL and the snapshot/profile inconsistency described above. CSV omits provider version/source/payload and escapes CSV syntax without spreadsheet-formula neutralization. Provide a stable evidence export with provenance, a defined policy for expiring media links, and safe handling of string cells that start with formula characters.

## Changes I recommend to the plan

The current plan is an engineering roadmap, not yet a complete plan for a sustainable business. Its July status understates implemented F6/F7/F9 features but overstates validation implied by “MVP complete.” Keep a separate status for implemented, locally tested, deployed, and customer-validated.

1. **Choose one first buyer and one recurring decision.** A reasonable hypothesis is a UX researcher or small research agency comparing two versions of the same software task using recordings they already collect. Validate this against actual prospects before treating it as decided. The offer could be: “Find and explain task friction with timestamped evidence, and compare a redesign using the same method.”
2. **Prove incremental value.** Dovetail, Maze, and UserTesting already market research/analysis capabilities. This establishes an existing market and alternatives, not demand for JAMS specifically. Compare JAMS against the buyer's actual workflow and tools: time to find an actionable issue, evidence quality, rework, and a decision made. [Dovetail](https://dovetail.com/), [Maze](https://maze.co/), [UserTesting](https://www.usertesting.com/platform).
3. **Treat measurement validity as its own deliverable.** Use consented, representative recordings with independent human annotations and a holdout split by participant/task. Include neutral narration, silence, accents, jargon, fast scrolling, static screens, accessibility tools, multiple apps, and delayed audio. Record precision/recall, transcript WER, timing errors, and uncertainty. Calibrate on a development set and evaluate on a separate holdout; agreement between Python and TypeScript only proves consistent arithmetic.
4. **Move minimum privacy and cost controls ahead of open signup.** Define upload authorization, sharing permissions, deletion/retention, model data destinations, access revocation, and support procedures. Optional labeling currently uses OpenRouter rather than the plan's direct Anthropic call; disclose and document the actual processor path before enabling it for customer data. This is a product/data-flow recommendation, not a legal compliance determination.
5. **Measure unit economics without sponsorship masking costs.** Record CPU/RAM seconds per input minute, cold-model overhead, retained original/derived bytes, playback egress, retries, and support time. Build scenarios by video length, resolution, retention, and reanalysis rate. Distinguish sponsored cash expense from unsubsidized cost. Zero paid-model tokens does not mean zero inference cost. No current Azure price quote or income projection was validated in this review.
6. **Define success before adding more providers.** Establish a small, time-boxed discovery/pilot experiment. Suggested decision criteria: several independent buyers supply their own recordings; at least a few agree to a paid pilot at an explicit price; they return for a second study; and they can describe a decision JAMS helped them make. These are proposed gates, not claims about existing traction or statistical significance. Freeze broader F10 work until this evidence justifies it.

## Recommended execution order and acceptance gates

| Gate | Work | Exit evidence |
|---|---|---|
| Reliability foundation | Findings 1–4, 9–10; durable dispatch, ownership, timebase | Failure-injection tests with real DB/queue; recovered killed workers; delayed-audio/VFR timing within the agreed tolerance |
| Trustworthy report | Findings 5–8; domain evaluation and versioned scoring | Missing data never masquerades as low effort; report/export/comparison agree; neutral narration and held-out recordings evaluated |
| Safe private pilot | Findings 11–13; quotas, immutable uploads, deletion, dependency updates | Clean required CI; cross-tenant negative tests; full media workflow; access revocation; bounded resource use |
| Authorized staging deployment | Containers, IaC, identity, roles, watchdog, backups, resource benchmark | Deploy/rollback and restore rehearsed; full end-to-end test; actual SKU throughput/memory/disk measured; alerts reach the owner |
| Repeatable paid use | One buyer/workflow, explicit pilot offer, measured value/cost | Repeat usage and willingness to pay; quantified support load; evidence customers trust and act on reports |

Run customer discovery alongside the technical work. It should determine what the later product scope needs to be. A patent-based architecture and a passing test suite are useful inputs; the decisive evidence is that customers repeatedly make a better decision with JAMS and pay enough to sustain its operation.

## Deliverables and unfinished verification

Added this review, `2026-09-05-worker-repro.py`, and a dependency-audit summary, `2026-09-05-dependency-audit.json`, in `docs/reviews/`. Application code and `docs/PLAN.md` remain unchanged so findings and proposed architecture changes can be addressed deliberately.

Unfinished verification: live Postgres isolation/concurrency and migration execution, browser E2E/visual accessibility review, actual Azure role/deployment behavior, 2-vCPU resource benchmark, backup restore, broad dependency exploitability/Python vulnerability assessment, real-customer measurement validation, patent review, and commercial validation. These are explicit remaining gates, not presumed passes.
