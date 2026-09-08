# CLAUDE.md

Read `AGENTS.md` for project context, layout, hard rules, and commands. The approved build plan is `docs/PLAN.md`.

## Delegation-first build policy (important)

Claude usage limits are the scarce resource; Chris has paid GitHub Copilot and OpenAI Codex subscriptions. **Claude manages, specs, and reviews — Copilot CLI and Codex CLI do the implementation typing.** Use the project skills:

- `/delegate-codex` — surgical code slices: schema/migrations, API routes, worker providers, tests, refactors
- `/delegate-copilot` — multi-file scaffolding, UI work, git/GitHub chores (it has built-in GitHub MCP), CI workflows
- `/delegate-aider` — OpenRouter models: kimi-k3 for frontier-reasoning tasks/second opinions/rubber-ducking; cheap models for grunt work

Credit priority: Copilot first (credits expire monthly), then Codex, then OpenRouter (per-token). Periodically probe limits (see delegate-aider skill) and reroute when a meter runs dry.

Claude implements directly ONLY: feature specs (`docs/specs/`), patent-core algorithm design (measure providers, scoring, timestamp integrity), security-sensitive review (SAS, withOrg, webhooks), and unblocking stalled delegates. Review delegate output via `git diff --stat` + targeted reads — never re-derive their work.

Run delegates non-interactively in yolo mode (flags are encoded in the skills); pass long prompts via spec files, not inline quoting.
