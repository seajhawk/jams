# JAMS — Journey/Task Effort & Sentiment Analysis SaaS: Build Plan

## Context

Chris's patent — *"Artificial Intelligence Assisted Method for Measuring and Quantifying Physical Effort, Cognitive Effort, and Sentiment While Performing a Task"* — has been granted. We are now building the product: a SaaS where users upload a video of someone performing a task/journey (screen capture + audio narration; webcam later), and the system quantifies **effort** and **sentiment**, producing an interactive timestamped report that deep-links into the video, with cross-run comparisons to follow.

The repo (`D:\git\jams`) holds 2023 prototype scripts (Azure Text Analytics sentiment, Google Video Intelligence shot detection, Azure Video Indexer) plus sample recordings in `videos/` that become golden test fixtures. Everything else is greenfield. Note: `.venv/` is currently committed to git (`.gitignore` only has `.env`) — cleanup is part of F1.

**Decisions made with Chris (2026-07-16):**
- **Host:** Azure (sponsorship credits cover infra). Near-zero cash cost; scale-to-zero; token budget reserved for *building*, not runtime or evals.
- **Stack:** Next.js (TypeScript, Tailwind v4, shadcn/ui) + Python 3.12 analysis worker.
- **Auth:** Clerk with Organizations; every user gets an auto-created personal org **hidden from the UI** (`<OrganizationSwitcher hidePersonal>`); billing at org level via **Stripe direct** (org.id as Stripe customer — Clerk Billing rejected: metered mode not GA, +0.7% fee).
- **MVP analyses:** ① context switches, ② time & task segmentation, ③ sentiment from audio narration. Design target ≤15-min videos (20-min hard cap).
- **Quality bar:** intuitive, delightful, polished enterprise-grade UX.

Design validated by a 7-agent research + judge-panel workflow (verified Azure pricing/free tiers, Clerk/Next.js facts, pipeline tech as of July 2026; three architecture proposals scored and synthesized).

## Patent → product mapping

| Patent element | Product realization | Phase |
|---|---|---|
| Effort & Sentiment Analyzer (Fig. 3) | Python worker with pluggable `MeasureProvider` pipeline | MVP |
| Time §[0016] | Segments from audio cues + context-switch boundaries | MVP |
| Context switches §[0020] | PySceneDetect on screen video (deterministic CV) | MVP |
| Sentiment §[0025] | Word-timestamped transcript → per-utterance sentiment | MVP |
| Effort Score §[0026] | Weighted aggregate; user-adjustable weight profiles | MVP |
| Report w/ video deep links §[0009] | Report page: multi-lane timeline + click-to-seek player | MVP |
| Measures DB / comparisons §[0009] | Canonical `measures` table from day 1; comparison UI F7 | MVP schema |
| Clicks/keypresses/scrolls §[0017–19] | Future CV providers + telemetry agent (claim 2) | F10+ |
| Concepts §[0021] / Choices §[0023] | Future OCR+NLP providers | F10+ |

> **Status 2026-07-17:** F1-F4 (MVP) complete and verified locally. **Azure provisioning is deferred by decision** - build and test locally (docker compose: Postgres + Azurite) until Chris green-lights deploy. No Azure meters run before then; deploy becomes Bicep + connection-string swaps when triggered.

## Architecture

**Exactly two deployable units** + managed services. They never call each other over HTTP: one Storage Queue message shape (`{run_id}`) in one direction, shared Postgres state in the other. UI polls run status at 2.5s.

1. **`jams-web`** — Next.js 16 (App Router) standalone container on Azure Container Apps Consumption (0.5 vCPU/1 GiB, min-replicas 0; flip to 1 at first external users to kill cold starts, ~$10–15/mo). Owns: all UI, Clerk auth, SAS minting (valet-key pattern), Clerk/Stripe webhooks, client-side Effort Score recompute (pure TS — weight sliders update instantly).
2. **`jams-worker`** — Python 3.12 event-driven **ACA Job** (2 vCPU/4 GiB, `--replica-timeout 3600` explicit — default is 1800s and jobs get killed ~30 min otherwise; parallelism 1, max 3 concurrent), woken from zero by KEDA azure-queue scaler. Contains the Analyzer as a **lightweight provider pipeline**: each analyzer implements `MeasureProvider` (id, version, requires, provides, run()) in a fixed linear order for MVP — extensibility contract without framework tax. Auths to Storage via managed identity (no keys).

**Media flow:** browser → Blob directly via 15-min write-only blob-scoped SAS (`@azure/storage-blob` BlockBlobClient, 4 MiB blocks, concurrency 4, per-block retry = practical resumability). Playback streams from a 1-hr read-only SAS straight into the player — Blob's HTTP Range/206 support makes scrubbing work with no CDN. Paths tenant-prefixed: `videos/{org_id}/{video_id}/original.ext`.

**Multi-tenancy:** every tenant row carries `org_id` (Clerk org id). One chokepoint: `withOrg()` wrapper resolves the active org from session claims (never client input) and injects it into every query; worker stamps org_id from the run row. Clerk webhooks (svix-verified) mirror orgs/users into Postgres through a `webhook_events` idempotency ledger. Postgres RLS is a scheduled hardening slice (F9), not MVP.

**Runtime AI cost engineered to $0:** transcription = faster-whisper `distil-small.en` (CTranslate2 INT8, weights baked into image); context switches = PySceneDetect **AdaptiveDetector** (not ContentDetector — fixed thresholds misread scrolling as cuts); sentiment = ONNX-quantized DistilBERT-SST2 on CPU. Exactly **one** optional LLM call in the whole system: feature-flagged Claude Haiku segment-naming (~$0.02/video, default off, always off in CI), which only merges/names deterministically-derived boundaries.

### Azure resources

- ACA environment + `jams-web` app (Consumption, min 0) — MVP traffic fits the monthly free grant (180k vCPU-s / 360k GiB-s / 2M req)
- ACA Job `jams-worker` (Consumption, KEDA azure-queue trigger, managed identity w/ Storage Blob Data Contributor)
- Storage account (StorageV2, LRS, Hot): containers `videos`, `derived`; queues `analysis-jobs`, `analysis-jobs-poison`; lifecycle: originals → Cool at 30 days
- **Postgres: Azure Database for PostgreSQL Flexible Server B1ms (~$13–17/mo — covered by Azure credits; Azure-native, low latency).** Vanilla schema keeps **Neon Free (0.5 GB, $0)** as a connection-string-swap escape hatch if credits expire. (Note: Neon's Azure-native Marketplace integration was retired in 2026 — standalone Neon runs on AWS.)
- Log Analytics (comes with ACA env), 1 GB/day cap, ~$0–2/mo
- External: GHCR for images (free; avoids ACR's ~$5/mo floor), Clerk free tier, Stripe, optional Anthropic API (Haiku)
- **Deliberately not provisioned:** Azure AI Speech (F0's 5 free hrs/mo exhausted immediately; local whisper is $0), Azure AI Language (local ONNX avoids the 5k-record cliff), Service Bus, ACR, CDN/Front Door, Media Services, AKS

**Cost:** idle ≈ $0–3/mo cash; ~100 analyses/mo ≈ $5–30 (mostly inside free grant); ~1000 analyses/mo ≈ $80–130. Postgres + pinned replica land on Azure credits, not cash.

## Data model

Postgres, DDL owned by **Drizzle migrations in the Next.js repo** (single source of truth); Python worker uses psycopg against the same schema, integration-tested against Drizzle-generated DDL in CI (prevents dual-language drift).

- `orgs` — id (Clerk org id) PK, name, is_personal, plan, stripe_customer_id · mirrored via webhooks
- `users` — id (Clerk user id) PK, email, display_name · membership read live from session claims
- `webhook_events` — source (clerk|stripe), external_id unique, payload, processed_at · idempotency ledger
- `tasks` — org_id, name unique-per-org, description · the journey definition and comparison axis
- `videos` — org_id, task_id?, title, blob_path, duration_ms, w/h/fps, has_audio, **subject_label** ("Participant 3"), **variant_label** (approach/competitor — powers comparisons), status, uploaded_by · row created *before* upload so the SAS ties to a known id
- `analysis_runs` — video_id, config jsonb (enabled providers, params, llm flag), pipeline_version, provider_versions, status (queued|running|succeeded|**partial**|failed), stage, progress_pct, stage_detail ("Transcribing… 6:20/14:05"), error_code (no_audio|too_long|corrupt_file|transient|unknown), attempt, superseded_by (re-run chain), timestamps
- `analysis_artifacts` — run_id, kind (audio_wav|transcript_json|keyframes|poster), blob_path
- **`measures`** — the canonical patent schema; every analyzer now and later emits only rows here: run_id, org_id, **kind** (context_switch|utterance|spoken_word|time_segment|sentiment| later click/keypress/scroll/concept/choice/telemetry_*), **category** (physical|cognitive|time|sentiment), **t_start_ms**, t_end_ms? (null = point event), value_num, value_text, unit, confidence, **source** (video_analysis|telemetry|manual), provider_id, provider_version, payload jsonb. Indexes (run_id, kind, t_start_ms), (org_id, kind). Telemetry agent later merges purely by timestamp — zero schema change. *This table is the patent claim.*
- `segments` — run_id, parent_segment_id? (task→sub-task tree), name, t_start_ms, t_end_ms, source (audio_cue|scene_boundary|llm|manual), thumbnail
- `weight_profiles` — org_id, name, weights jsonb ({kind: weight}), normalization jsonb (per_minute|raw|z_score), is_default · patent's adjustable weights as named org assets, default seeded on org creation
- `effort_scores` — PK(run_id, profile_id): physical/cognitive/time/sentiment/total + **breakdown jsonb** (raw → normalized → weighted contribution, so the UI answers "why is this 62?") · worker writes default snapshot; client recomputes on slider drag
- `share_links` (F6) — run_id, token, expires_at

### API surface (Next.js route handlers, all through `withOrg`)

`POST /api/videos` (create row + write SAS) · `POST /api/videos/:id/complete` · `GET /api/videos[/:id]` · `GET /api/videos/:id/playback-sas` · `POST /api/analyses` (create/re-run) · `GET /api/analyses/:id` (status poll) · `GET /api/analyses/:id/report` (one fat payload: segments+measures+score) · `GET /api/analyses/:id/measures?kind=` (future public-API shape) · `GET/PUT/PATCH /api/weight-profiles` · `POST /api/webhooks/{clerk,stripe}` · `POST /api/admin/watchdog` (GitHub Actions schedule sweeps runs stuck >60 min)

## Analysis pipeline (worker stages)

1. **Claim & heartbeat** — idempotency guard (skip if succeeded), status=running, stage/progress written to Postgres after every stage (feeds live stepper)
2. **Probe & normalize** — ffprobe validation, ≤20-min cap with typed errors; **ffmpeg VFR→CFR normalization** (deep-link timestamp integrity is the patent promise); extract 16 kHz mono WAV; poster frame
3. **Context switches** — PySceneDetect AdaptiveDetector (min_scene_len≈1s, tuned on golden fixtures incl. heavy-scroll and long-idle clips) → `measures kind='context_switch'` + keyframe thumbnail per cut; fallback behind same interface: dHash frame-diff w/ hysteresis
4. **Transcription** — faster-whisper distil-small.en INT8, Silero VAD, word_timestamps=True → transcript artifact + `utterance` + `spoken_word` measures; no audio → skip dependent stages, finish `partial`. **Hard gate: benchmark on the real 2 vCPU ACA SKU before any latency promise ships**
5. **Sentiment** — DistilBERT-SST2 ONNX INT8 per utterance → `sentiment` measures (value −1..+1)
6. **Task segmentation** — regex cue pass ("let's get started", "okay next", "done") ∪ context-switch boundaries, rule-merged (min 10s, snap cues to switches within 3s) → `segments` + `time_segment` measures; optional flagged Haiku call only names/merges candidates
7. **Scoring** — normalize per default weight profile (physical: words/min; cognitive: switch rate + negative-sentiment density + segment count; time: durations) → `effort_scores` snapshot; same formula in TS and Python, parity-tested
8. **Finalize & failure handling** — delete-then-insert per (run_id, provider_id) = idempotent retries; per-provider try/except → `partial` report with honest banner + one-click retry, never a dead end; crash → queue visibility-timeout redelivery; dequeue_count>3 → poison queue; watchdog for stuck runs

## Feature roadmap (each independently shippable; F1–F4 = MVP)

- **F0 — Delegation tooling (hours, not days).** `.claude/skills/delegate-codex` + `.claude/skills/delegate-copilot` skills; shared `AGENTS.md` + `CLAUDE.md`; smoke-test both CLIs on a trivial repo task (e.g., the F1 repo cleanup). *Everything after this is built mostly on Copilot/Codex credits.*
- **F1 — Foundation + Demo Report.** Monorepo (pnpm + uv): `apps/web`, `worker/`, `infra/` (Bicep via azd), `fixtures/`; repo cleanup (untrack `.venv`, move 2023 prototypes to `legacy/`); CI/CD GitHub Actions → GHCR → ACA. Clerk orgs (hidden personal org) + webhook mirror. App shell (Library/Tasks/Settings). **The complete interactive report page built first against hand-authored golden-fixture JSON** — Vidstack player, Recharts multi-lane timeline (sentiment gradient, context-switch dots, segment bands), sentiment-colored click-to-seek transcript, score dial with breakdown, live weight sliders — seeded as a demo report in every new org. *Retires the hardest UI risk before the pipeline exists, freezes the data contract, and gives day-one users the payoff moment.*
- **F2 — Upload + Video Library.** tasks/videos tables, SAS routes, drag-drop parallel-block upload with instant local poster/duration + real MB/s progress, library grid, playback page. *Useful as an org-scoped video vault with zero analysis.*
- **F3 — Pipeline v1: spine + scenes + transcript.** Queue + KEDA ACA Job, run status machine + live stepper, poison/watchdog handling, probe/CFR stage, context-switch provider, transcription provider. **Includes golden-fixture CI harness** (cuts ±1s, WER <5%, cross-stage timestamp agreement ±250ms) **and the whisper CPU benchmark gate.**
- **F4 — Sentiment + Segmentation + Effort Score → MVP complete.** Sentiment provider, segmentation, weight profiles + scores (client recompute parity-tested), bind F1 report to live data, partial-run rendering.
- **F5 — Processing delight.** "Found so far" incremental teasers, duration-based ETA, email-when-done, report-shaped skeletons, keyboard shortcuts.
- **F6 — Re-run/versioning, Haiku labeling, sharing.** superseded_by run chains, flagged segment naming, expiring share links, CSV/JSON export.
- **F7 — Comparison v1.** Side-by-side runs of the same task, aligned by segment; score deltas. Pure read-side over canonical measures — *the patent's comparison core.*
- **F8 — Billing + quotas.** Stripe direct, org subscriptions, free-tier gate (N analyses/mo), entitlements via webhook ledger.
- **F9 — Config authoring + hardening.** Per-run YAML analysis config w/ JSON Schema validation (patent data-format fidelity), Postgres RLS, admin page for failed runs.
- **F10+ — designed-for, not built:** clicks/keypresses/scrolls CV providers, OCR concepts/choices, webcam/prosody sentiment fusion, telemetry agent (source='telemetry', clock-offset merge), public API. *New providers and rows — never a re-architecture.*

## Build process: token-efficient delegation

The scarce resource is Claude usage (81% of a 4-hour window consumed by planning alone). Policy: **Fable manages, specs, and reviews; GitHub Copilot CLI and OpenAI Codex CLI do the typing on Chris's separate paid credits.** Both are installed and support non-interactive yolo mode.

**Delegation commands (verified against installed CLI help):**
- Codex: `codex exec "<spec>" --dangerously-bypass-approvals-and-sandbox -C <dir> -o <last-msg.txt> [-m <model>] [--output-schema <schema.json>]`; `codex exec resume --last` to continue; `codex review` for non-interactive code review
- Copilot: `copilot -p "<spec>" --yolo --no-ask-user -s [--model auto|<model>] [--max-ai-credits N] [--share <log.md>]`; built-in GitHub MCP makes it the choice for PR/issue/repo chores

**First implementation task (F0, before F1):** create two thin project skills — `.claude/skills/delegate-codex/SKILL.md` and `.claude/skills/delegate-copilot/SKILL.md` — encoding the command templates above, prompt-spec conventions (self-contained: exact paths, acceptance criteria, "run the tests, end with a change summary"), model-choice guidance, and the review loop. Also write a shared **`AGENTS.md`** (both Codex and Copilot auto-load it) with stack, commands, directory map, and conventions, plus a `CLAUDE.md` that references it — so no delegate ever burns credits re-deriving context.

**Division of labor:**
- **Codex CLI** — surgical, well-specified code slices: Drizzle schema/migrations, API routes, worker providers, tests; `--output-schema` for structured handoffs
- **Copilot CLI** — multi-file scaffolding, UI component work, git/GitHub chores (branches, commits, PRs via its GitHub MCP), CI workflows
- **Fable (me), sparingly** — feature specs, patent-core algorithm design (measure providers, scoring, timestamp integrity), security-sensitive review (SAS, withOrg, webhooks), diff review of delegated work (`git diff --stat` + targeted reads, never re-derivation), and unblocking when a delegate stalls
- Claude Haiku subagents only as fallback when conversation context is required

**Cadence per feature:** Fable writes a spec file → delegate implements (Codex or Copilot, run from Bash so only their final summary enters my context) → tests run by the delegate → Fable reviews the diff → Copilot commits/pushes/PRs. Evals stay deterministic pytest golden fixtures — **zero LLM-as-judge spend, LLM flag always off in CI**.

## Verification

For the next release sequence, customer-discovery draft, and explicit pilot exit
gates, see [First customer pilot](PILOT-RELEASE.md). Implementation status does not
establish deployment readiness or customer validation.

- **F1:** deployed app renders the demo report from fixture JSON; click a timeline event → player seeks to the moment. Playwright smoke: sign-up → demo report interaction.
- **F2:** upload `videos/SettingUpGoogleVideoAnalyzer...mp4` through the real browser flow (Azurite locally, Blob in staging); verify playback scrubbing via SAS URL.
- **F3/F4:** golden-fixture CI — fixture videos (2023 samples + scripted scroll-heavy, long-idle, and timestamp-agreement clips) run through the real worker container; assert cut timestamps ±1s, WER <5%, sentiment ±0.1, cross-stage timestamps ±250ms. Whisper benchmark on real ACA SKU recorded before latency promises.
- **End-to-end golden path (every feature):** upload fixture → watch live stepper → report renders → deep links land on the right video moments. Local dev: docker-compose (Azurite + Postgres), worker run directly, Clerk dev instance.

## Top risks & mitigations

1. **Whisper CPU throughput unbenchmarked on 2-vCPU x86** — F3 hard benchmark gate; levers: distil model, 5-fps proxy, 4 vCPU; worst case Azure Speech batch ($0.18/hr ≈ $3/mo @100 analyses).
2. **AdaptiveDetector on screen capture is unproven for scrolling/static screens** — scroll-heavy + long-idle fixtures tuned before F3 ships; per-cut confidence + thumbnails let users audit; dHash fallback behind same interface.
3. **Timestamp drift breaks the deep-link promise** — mandatory CFR normalization + ±250ms cross-stage golden fixture.
4. **ACA Jobs ~30-min kill** — explicit `--replica-timeout 3600` in IaC, 20-min upload cap, idempotent stage writes.
5. **Text-only sentiment misses tone** — frame as "narration sentiment", segment-level aggregation, confidence shown; prosody provider reserved as later upgrade.
6. **Effort Score trust** — transparent per-kind breakdown, explicit normalization, comparisons framed relative (same task, same profile).
7. **Solo-dev scope gravity** — ruthless two-unit rule: every new idea must be a provider row or a read-side feature, never a new service.
8. **Tenant/PII safety** (screen recordings may contain credentials) — withOrg chokepoint with tests, short SAS expiries, org-prefixed paths, managed identity, RLS at F9 before enterprise customers.
