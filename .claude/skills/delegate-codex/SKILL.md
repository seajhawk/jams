---
name: delegate-codex
description: Delegate a well-specified coding task to the OpenAI Codex CLI (non-interactive, full-auto) to conserve Claude tokens. Use for surgical implementation slices — Drizzle schema/migrations, API routes, worker measure providers, tests, refactors. Claude writes the spec and reviews the diff; Codex burns OpenAI credits doing the typing.
---

# Delegate to Codex CLI

## 1. Write the spec

Put it in `docs/specs/<feature>-<slice>.md` (committed, reusable) or the scratchpad for throwaway chores. A good spec is fully self-contained:
- Goal in one sentence, then exact scope (files to create/modify with paths)
- Constraints that apply (AGENTS.md is auto-loaded by Codex, so only slice-specific rules)
- Acceptance criteria + which tests/lint to run
- End with: "Finish by running the tests and printing a concise summary of every file you changed and anything left incomplete. Then append one row for this run to docs/delegation-log.md (delegate=Codex, model from your session, grade ✅/⚠️/❌ per that file's legend, terse note) without rewriting the file."

## 2. Run it

Pass the spec via stdin (`-`) to avoid Windows quoting problems. Use the Bash tool with `timeout: 600000`, or `run_in_background: true` for long tasks:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  -C "D:/git/jams" -o "$TMPDIR/codex-last.md" - < docs/specs/my-spec.md
```

- `-o <file>` writes only the final message — read that, not the full stdout
- `-m <model>` overrides the model; omit to use the configured default
- `--output-schema <schema.json>` forces a JSON final answer (great for structured handoffs)
- Follow-up in the same session: `codex exec resume --last "fix the failing test" --dangerously-bypass-approvals-and-sandbox`
- Non-interactive code review of the working tree: `codex review --dangerously-bypass-approvals-and-sandbox`

## 3. Review (Claude's job — cheap)

1. Read the `-o` output file for the summary
2. `git status --short && git diff --stat` — scope sanity
3. Targeted Read of security-sensitive or patent-core files only
4. Have the delegate run tests if it didn't; never mark done on failing tests

If Codex stalls or misunderstands twice, stop retrying — fix the spec or escalate to Claude implementation.
