# Spec F1-a: Monorepo Scaffold

Branch: `f1-foundation` (already created off `f0-repo-cleanup`)
Repo root: `D:\git\jams`

You are a non-interactive implementation agent running on Windows. Execute every command with PowerShell. Do NOT push or open PRs. Commit in logical chunks with the message format shown below.

## IMPORTANT: Read before starting

- Do NOT touch: `videos/`, `legacy/`, `.env`, `docs/PLAN.md`, `.claude/`
- Current toolchain: pnpm 10.11.0, node v26.4.0, uv 0.11.26, Python 3.11.9
- Branch `f1-foundation` is already checked out

---

## Chunk 1: Workspace root

### 1a. `package.json` (repo root)
Create `D:\git\jams\package.json`:
```json
{
  "name": "jams",
  "private": true,
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "pnpm --filter web dev",
    "build": "pnpm --filter web build",
    "test": "pnpm --filter web test",
    "lint": "pnpm --filter web lint"
  },
  "packageManager": "pnpm@10.11.0"
}
```

### 1b. `pnpm-workspace.yaml` (repo root)
Create `D:\git\jams\pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
```

### 1c. Root `readme.md`
Replace the existing empty `D:\git\jams\readme.md` with:
```markdown
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
```

### 1d. Commit

```
git add package.json pnpm-workspace.yaml readme.md
git commit -m "chore: workspace root — package.json, pnpm-workspace.yaml, readme

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Chunk 2: apps/web — Next.js scaffold

### 2a. Scaffold Next.js

From `D:\git\jams`, run:
```
pnpm create next-app apps/web --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack --skip-install
```

If that flag set doesn't work non-interactively, use: `--yes` or try without `--no-turbopack`. The goal is TypeScript strict, App Router, Tailwind CSS v4, ESLint, src/ directory, `@/*` import alias.

After scaffolding, manually ensure `tsconfig.json` has `"strict": true` in compilerOptions.

### 2b. Clean the default content

Replace `apps/web/src/app/page.tsx` with a minimal placeholder:
```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-4xl font-bold">JAMS</h1>
    </main>
  );
}
```

Replace `apps/web/src/app/globals.css` with minimal Tailwind v4 imports (keep whatever `create-next-app` generates for Tailwind v4, just strip any default Next.js demo styles that are purely cosmetic/marketing-page).

### 2c. Install dependencies

From `apps/web`:
```
pnpm install
```

### 2d. Initialize shadcn/ui

From `apps/web`, run:
```
pnpm dlx shadcn@latest init --defaults --base-color neutral --yes
```

If that command requires interaction, try these flags: `--defaults`, `--yes`, `-y`, `--force`. Accept all defaults. Base color: neutral.

### 2e. Add shadcn/ui components

From `apps/web`, add these components:
```
pnpm dlx shadcn@latest add button card dialog dropdown-menu input label skeleton sonner tabs tooltip slider badge separator --yes
```

If this fails in one shot, add them one at a time.

### 2f. Add vitest

From `apps/web`, install vitest:
```
pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom
```

Create `apps/web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

Update `package.json` in `apps/web` to add test script:
```json
"test": "vitest run"
```

Create `apps/web/src/__tests__/smoke.test.tsx`:
```tsx
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('passes', () => {
    expect(true).toBe(true)
  })
})
```

### 2g. Verify

From `apps/web`, run `pnpm build` — it must succeed.
From `apps/web`, run `pnpm test` — it must succeed.

### 2h. Commit

```
git add apps/web
git commit -m "feat(web): scaffold Next.js with TypeScript, Tailwind v4, shadcn/ui, vitest

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Chunk 3: worker/

### 3a. Initialize uv project

From `D:\git\jams`, run:
```
uv init worker --package
```

If uv init doesn't support `--package`, run `uv init worker` then check what it creates and adapt accordingly. The goal is a Python project with `pyproject.toml`, a `src/` layout with package `jams_worker`.

### 3b. pyproject.toml

Edit `worker/pyproject.toml` to ensure:
- `[project]` name = `"jams-worker"`, requires-python = `">=3.12"`
- `[project.optional-dependencies]` or `[dependency-groups]` dev deps: `pytest>=8`, `ruff>=0.8`
- Build backend: hatchling (uv default) or whatever uv init set up

If uv created a flat layout (worker.py at top), restructure to:
- `worker/src/jams_worker/__init__.py`
- `worker/src/jams_worker/pipeline.py`

### 3c. pipeline.py

Create `worker/src/jams_worker/pipeline.py`:
```python
"""Pluggable analysis pipeline contracts."""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class MeasureProvider(Protocol):
    """Every analysis stage implements this interface."""

    @property
    def id(self) -> str:
        """Stable provider identifier (e.g. 'context_switch_v1')."""
        ...

    @property
    def version(self) -> str:
        """Semver string."""
        ...

    @property
    def requires(self) -> list[str]:
        """Artifact kinds this provider needs as input."""
        ...

    @property
    def provides(self) -> list[str]:
        """Measure kinds this provider emits."""
        ...

    def run(self, context: dict[str, Any]) -> list[dict[str, Any]]:
        """Execute the provider and return measure rows."""
        ...
```

### 3d. Passing pytest

Create `worker/tests/__init__.py` (empty).

Create `worker/tests/test_pipeline.py`:
```python
"""Smoke tests for MeasureProvider protocol."""
from jams_worker.pipeline import MeasureProvider
from typing import Any


class _FakeProvider:
    """Minimal concrete implementation of MeasureProvider."""

    @property
    def id(self) -> str:
        return "fake_v1"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def requires(self) -> list[str]:
        return []

    @property
    def provides(self) -> list[str]:
        return ["fake_measure"]

    def run(self, context: dict[str, Any]) -> list[dict[str, Any]]:
        return []


def test_measure_provider_protocol() -> None:
    provider = _FakeProvider()
    assert isinstance(provider, MeasureProvider)
    assert provider.id == "fake_v1"
    assert provider.version == "1.0.0"
    assert provider.requires == []
    assert provider.provides == ["fake_measure"]
    assert provider.run({}) == []
```

### 3e. ruff config

Add to `worker/pyproject.toml` under `[tool.ruff]`:
```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I"]
```

### 3f. Verify

From `worker/`:
```
uv sync
uv run pytest
uv run ruff check
```
Both must pass.

### 3g. Commit

```
git add worker/
git commit -m "feat(worker): uv project with MeasureProvider protocol and pytest

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Chunk 4: docker-compose + .env.example + infra stub

### 4a. docker-compose.yml

Create `D:\git\jams\docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: jams
      POSTGRES_PASSWORD: jams
      POSTGRES_DB: jams
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U jams"]
      interval: 5s
      timeout: 5s
      retries: 5

  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    ports:
      - "10000:10000"  # blob
      - "10001:10001"  # queue
      - "10002:10002"  # table
    volumes:
      - azurite_data:/data
    command: azurite --blobHost 0.0.0.0 --queueHost 0.0.0.0 --tableHost 0.0.0.0 --location /data --debug /data/debug.log

volumes:
  postgres_data:
  azurite_data:
```

### 4b. .env.example

Create `D:\git\jams\.env.example`:
```
# Local development environment variables
# Copy to .env and fill in values for non-local services

# Postgres (docker compose default)
DATABASE_URL=postgresql://jams:jams@localhost:5432/jams

# Azurite local storage emulator (well-known devstoreaccount1 credentials)
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tiq/K8YpkNnY4YOEgHBN;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;

# Clerk (get from clerk.com dashboard)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=

# Stripe (get from stripe.com dashboard)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

### 4c. infra/readme.md

Create `D:\git\jams\infra\readme.md`:
```markdown
# infra/

Bicep templates and `azd` configuration for Azure deployment.

**Coming in a later feature slice (post-MVP).**

Planned resources:
- Azure Container Apps environment
- `jams-web` ACA app (Consumption, min-replicas 0)
- `jams-worker` ACA Job (KEDA azure-queue scaler)
- Azure Storage account (blobs + queues)
- Azure Database for PostgreSQL Flexible Server (B1ms)
- Log Analytics workspace

Local development uses `docker compose` (Postgres + Azurite) from the repo root.
```

### 4d. Verify

From `D:\git\jams`:
```
docker compose config
```
Must succeed (validates the compose file).

### 4e. Commit

```
git add docker-compose.yml .env.example infra/
git commit -m "chore: docker-compose (postgres+azurite), .env.example, infra stub

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Chunk 5: CI workflow

### 5a. Create workflow file

Create `D:\git\jams\.github\workflows\ci.yml`:
```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:
    branches: ["**"]

jobs:
  web:
    name: Web
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/web

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "pnpm"
          cache-dependency-path: apps/web/pnpm-lock.yaml

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Build
        run: pnpm build

      - name: Test
        run: pnpm test

  worker:
    name: Worker
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: worker

    steps:
      - uses: actions/checkout@v4

      - name: Set up uv
        uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"

      - name: Install dependencies
        run: uv sync

      - name: Lint
        run: uv run ruff check

      - name: Test
        run: uv run pytest
```

### 5b. Commit

```
git add .github/
git commit -m "ci: GitHub Actions — web (pnpm/lint/build/test) + worker (ruff/pytest)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final verification

Run these commands and report pass/fail for each:

1. `cd D:\git\jams\apps\web && pnpm build`
2. `cd D:\git\jams\apps\web && pnpm test`
3. `cd D:\git\jams\worker && uv run pytest`
4. `cd D:\git\jams\worker && uv run ruff check`
5. `cd D:\git\jams && docker compose config`

## Summary report

End your run with:
- Branch name
- `git log --oneline` for the commits on this branch
- Each verification command with PASS or FAIL
- Anything incomplete or that needs manual follow-up
