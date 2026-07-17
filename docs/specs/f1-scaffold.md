# Spec F1-a: Monorepo scaffold

Goal: turn this repo into the two-unit monorepo described in `docs/PLAN.md` (read its Architecture section first), with local dev + CI working. Stay on branch `f0-repo-cleanup`? No — create branch `f1-foundation` off `f0-repo-cleanup`.

## Scope

1. **Workspace root:** `package.json` (private, engines node >=22), `pnpm-workspace.yaml` covering `apps/*`. If pnpm is unavailable, run `corepack enable` first. Root `readme.md`: replace the empty file with a short project intro + quickstart (dev setup for web, worker, and docker compose).
2. **apps/web:** scaffold Next.js (latest stable) with TypeScript strict, App Router, Tailwind CSS v4, ESLint, `src/` directory, import alias `@/*` — use `pnpm create next-app` with non-interactive flags. Then initialize shadcn/ui (`pnpm dlx shadcn@latest init`, defaults, neutral base color) and add components: `button card dialog dropdown-menu input label skeleton sonner tabs tooltip slider badge separator`. Add `vitest` + a trivial passing unit test. Verify `pnpm build` succeeds.
3. **worker/:** Python 3.12 project managed by `uv` (`uv init --package worker` layout or equivalent): `pyproject.toml` with dev deps `pytest`, `ruff`; package `jams_worker` with a placeholder `pipeline.py` (empty `MeasureProvider` protocol: id, version, requires, provides, run) and one passing pytest. Verify `uv run pytest` succeeds. Do NOT add heavy analysis deps yet (no pyscenedetect/whisper — those come in F3).
4. **docker-compose.yml** at root: `postgres:16` (port 5432, user/pass/db `jams`, named volume) + `mcr.microsoft.com/azure-storage/azurite` (blob 10000, queue 10001, named volume). Add `.env.example` at root documenting DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING for local Azurite (use the well-known Azurite devstoreaccount1 connection string).
5. **.github/workflows/ci.yml:** on push/PR — job web: pnpm install → lint → build → test (working-directory apps/web, cache pnpm); job worker: uv sync → ruff check → pytest (working-directory worker, astral-sh/setup-uv). No Docker/GHCR/deploy jobs yet.
6. **infra/**: just a `readme.md` stub noting Bicep/azd lands in a later slice.

## Rules

- Do not touch `videos/`, `legacy/`, `.env`, `docs/PLAN.md`, `.claude/`.
- Follow AGENTS.md conventions. Keep generated boilerplate pruned (delete default Next.js marketing page content; a minimal placeholder home page saying "JAMS" is fine).
- Commit in logical chunks on `f1-foundation` (e.g., workspace, web, worker, compose+CI). Do not push.

## Acceptance

- `pnpm build` and `pnpm test` pass in `apps/web`; `uv run pytest` and `uv run ruff check` pass in `worker/`; `docker compose config` validates.
- Finish by printing: branch, `git log --oneline` for your commits, each verification command with pass/fail, and anything incomplete.
