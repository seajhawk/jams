# JAMS — Journey & Task Effort Analysis

SaaS implementation of a granted patent for measuring physical effort, cognitive effort, and sentiment from task-performance videos.

## What it does

Upload a screen-capture + narration video → get timestamped measures of effort and sentiment → interactive report with video deep links and cross-run comparisons.

## Repo layout

- `apps/web/` — Next.js 16, TypeScript strict, App Router, Tailwind v4, shadcn/ui
- `worker/` — Python 3.12 analysis pipeline (uv). Pluggable `MeasureProvider` architecture
- `infra/` — Bicep (azd) for Azure Container Apps, Storage, Postgres (coming in a later slice)
- `fixtures/` — Golden test fixtures (sample videos + expected-output JSON)
- `legacy/` — 2023 prototype scripts. Reference only; never import from here
- `docs/` — Architecture plan (`PLAN.md`) and feature specs

## Quickstart

### Prerequisites

- Node ≥ 22 + pnpm (`corepack enable`)
- Python 3.12 + uv (`pip install uv`)
- Docker Desktop (for local Postgres + Azurite)

### Web app

```bash
cd apps/web
pnpm install
pnpm dev           # http://localhost:3000
pnpm build         # production build
pnpm test          # vitest
```

### Worker

```bash
cd worker
uv sync
uv run pytest
uv run ruff check
```

### Local stack (Postgres + Azurite)

```bash
# From repo root
cp .env.example .env   # fill in any overrides
docker compose up -d
```

See `.env.example` for required environment variables.
