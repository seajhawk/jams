# JAMS — Agent Instructions

JAMS is a SaaS implementing a granted patent: users upload a video (screen capture + audio narration) of someone performing a task/journey; the system produces timestamped **measures** of physical effort, cognitive effort, and sentiment, an adjustable weighted **Effort Score**, and an interactive report that deep-links to exact video moments.

**Read `docs/PLAN.md` before non-trivial work** — it is the approved architecture, data model, pipeline, and roadmap. Do not deviate from it silently.

## Repo layout (target — being built out feature by feature)

- `apps/web/` — Next.js 16, TypeScript strict, App Router, Tailwind v4, shadcn/ui. All UI + API route handlers + Drizzle schema/migrations (TypeScript owns ALL DDL).
- `worker/` — Python 3.12 analysis pipeline (uv-managed). ffmpeg, PySceneDetect, faster-whisper, onnxruntime. Talks to Postgres via psycopg; never defines schema.
- `infra/` — Bicep (azd) for Azure Container Apps, Storage, Postgres.
- `fixtures/` — golden test fixtures (sample videos + expected-output JSON).
- `legacy/` — 2023 prototype scripts and analysis outputs. Reference only; never import from here.
- `docs/` — PLAN.md (the approved plan), specs for delegated feature work in `docs/specs/`.
- `videos/` — original 2023 sample recordings (fixture sources).

## Hard rules

1. **Multi-tenancy:** every tenant-owned row carries `org_id` (Clerk org id). In `apps/web`, all DB access goes through the `withOrg()` chokepoint — never accept org_id from client input. The worker stamps `org_id` from the `analysis_runs` row.
2. **Canonical measures:** analyzers emit ONLY rows in the `measures` table (kind, category, t_start_ms, t_end_ms?, value_num, value_text, confidence, source, provider_id, provider_version, payload). Never invent a side table for a new measure type.
3. **No LLM calls in tests/CI.** The single optional LLM call (segment naming) is feature-flagged and defaults off. Evals are deterministic pytest golden fixtures with tolerance windows.
4. **Timestamps are sacred** — they power the deep-link-to-video patent claim. Video processing must go through the CFR normalization stage; cross-stage timestamp agreement is golden-tested at ±250ms.
5. **Two deployable units only** (`jams-web`, `jams-worker`). New capability = a new MeasureProvider or a read-side feature, never a new service.
6. **Secrets:** never commit `.env*`; SAS tokens are minted server-side only (15-min write / 60-min read).

## Commands

- Web: `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm lint` (from `apps/web`)
- Worker: `uv sync`, `uv run pytest`, `uv run ruff check` (from `worker`)
- Local stack: `docker compose up` (Azurite + Postgres) from repo root

## Conventions

- Branches: `f<N>-short-name` per roadmap feature. Conventional-ish commit subjects, imperative mood.
- TypeScript: strict, no `any` without a comment. Python: ruff + type hints.
- UI: shadcn/ui components, polished enterprise aesthetic; loading states are skeletons shaped like the content, errors are honest with a retry action, empty states teach.
- Always run the relevant tests/lint before declaring a task done, and end your run with a concise summary of files changed and anything you could not complete.
