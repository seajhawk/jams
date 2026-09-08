---
name: delegate-aider
description: Delegate to aider CLI backed by OpenRouter — use kimi-k3 for hard problems (complex debugging, design consults, rubber-ducking) and free/cheap OpenRouter models for grunt work. Third-priority delegate — use AFTER Copilot (credits expire monthly, July 31 now) and Codex, since OpenRouter bills per token.
---

# Delegate to aider (OpenRouter)

Key: `OPENROUTER_API_KEY` is a Windows user-level env var (new terminals have it). If absent in this session, pass `--api-key openrouter=$OPENROUTER_API_KEY` after exporting, or inline the key from the user.

## Code task (one-shot, edits + auto-commits)

```bash
aider --model openrouter/moonshotai/kimi-k3 --yes-always --no-stream \
  --message-file docs/specs/my-spec.md path/to/file1.ts path/to/file2.py
```
- Name the files to edit as args — aider only reliably touches listed files (plus its repo map for context)
- Cheap tier for grunt work: pick with `aider --list-models openrouter/` (many free/near-free); good default pattern: kimi-k3 as `--architect` with a cheap `--editor-model`
- `--auto-test --test-cmd "pnpm test"` makes aider self-verify; it auto-commits by default (review diff after, as with any delegate)

## Consult / rubber-duck (NO file edits)

```bash
aider --model openrouter/moonshotai/kimi-k3 --no-git --yes-always --no-stream \
  --message "Here is the problem: ... What am I missing?"
```
Run from a temp dir (or `--no-git`) so nothing is committed; paste code inline or list files read-only via /read semantics (files named with --no-git are context only).

## Routing & credit priority (Chris's rule)

1. **Copilot first** (monthly credits expire — currently July 31), 2. **Codex** (plan credits), 3. **aider/OpenRouter** (per-token) — but jump straight to kimi-k3 when a task needs frontier reasoning the others fumbled, or for a second opinion on a hard design/debug question.

## Limit checks (periodic — roughly every few delegated runs)

- Copilot: run a stats ping `copilot -p "reply OK" --allow-all-tools` WITHOUT `-s` and read the printed credit stats; if exhausted/erroring, stop routing to Copilot until reset.
- Codex: no scriptable quota — watch run output for rate-limit/429 errors; on hitting limits, reroute to the others.
- Log notable limit events in docs/delegation-log.md notes.
