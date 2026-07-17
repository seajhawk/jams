---
name: delegate-copilot
description: Delegate a task to the GitHub Copilot CLI (non-interactive, yolo) to conserve Claude tokens. Use for multi-file scaffolding, UI component work, CI workflows, and git/GitHub chores (branches, commits, pushes, PRs — it has built-in GitHub MCP). Claude writes the spec and reviews the diff; Copilot burns Copilot credits doing the typing.
---

# Delegate to Copilot CLI

## 1. Write the spec

Same conventions as delegate-codex: self-contained, exact paths, acceptance criteria, "end with a concise summary of changes". Copilot auto-loads `AGENTS.md`. Spec files live in `docs/specs/` (committed) or the scratchpad (throwaway).

## 2. Run it

Use the Bash tool with `timeout: 600000` (or `run_in_background: true`):

```bash
copilot -p "$(cat docs/specs/my-spec.md)" --yolo --no-ask-user -s --log-level none
```

- `--yolo` = allow all tools/paths/urls (required for non-interactive); `--no-ask-user` = never blocks on questions; `-s` = print only the agent's final response
- `--model auto` (default is fine) or a specific model; `--max-ai-credits <n>` caps spend per task
- `--share <file.md>` saves a full session log if you need an audit trail
- Resume a session: `copilot --resume <session-id> -p "follow-up" --yolo --no-ask-user -s`
- GitHub chores (PR create, issue ops) work out of the box via its GitHub MCP server

## 3. Review (Claude's job — cheap)

1. Read its final response (that's all `-s` prints)
2. `git status --short && git diff --stat` — scope sanity
3. Targeted Read of anything security-sensitive; tests must pass before a task is done

If Copilot stalls or misunderstands twice, stop retrying — fix the spec or switch delegates.
