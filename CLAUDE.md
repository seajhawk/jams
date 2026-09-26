# CLAUDE.md

Read `AGENTS.md` for project context, layout, hard rules, and commands. The approved build plan is `docs/PLAN.md`.

## Build policy: usage-gated (important)

Chris sets the budget; the gate is Claude's **weekly** plan usage ("Weekly · all models"), read with the `get_usage` session tool (or ask Chris). Check it at the start of any substantial build task and again every few slices.

- **Below 80% weekly usage: Claude implements directly.** Specs, code, tests, reviews, all of it, in this session or Claude subagents. Do not spend time writing delegate prompts while Claude has budget.
- **At or above 80%: delegate the typing** through the project skills, and Claude goes back to specs and reviews:
  - `/delegate-codex`: surgical code slices (schema/migrations, API routes, worker providers, tests, refactors)
  - `/delegate-copilot`: multi-file scaffolding, UI work, git/GitHub chores, CI workflows. **Out of credits as of 2026-09-25**; confirm it has credits before routing to it.
  - `/delegate-aider`: OpenRouter models (kimi-k3 for hard reasoning or second opinions; cheap models for grunt work; bills per token)
  - Order when delegating: whichever of Copilot/Codex has credits, then OpenRouter. If every meter is dry, pause and ask Chris.
- Regardless of the gate, Claude always owns: feature specs (`docs/specs/`), patent-core algorithm design (measure providers, scoring, timestamp integrity), security-sensitive work (SAS, withOrg, webhooks, auth), and review of anything a delegate produced (`git diff --stat` + targeted reads, never re-derive their work).

Delegates run non-interactively in yolo mode (flags are encoded in the skills); pass long prompts via spec files, not inline quoting.
