# Delegation scorecard

Track every delegated run so we route work to whoever does it best. Update after each run (the delegate skills require it). Grade: ✅ clean · ⚠️ needed fixes/retry · ❌ failed.

| Date | Task | Delegate | Model | Grade | Notes |
|---|---|---|---|---|---|
| 2026-07-16 | F0 repo cleanup (git surgery) | Codex | gpt-5.5 (high) | ✅ | Exact scope, ~47k tokens, clean commit |
| 2026-07-16 | F0 tooling commit (git chore) | Copilot | claude-sonnet-4.6 | ✅ | Exact, fast |
| 2026-07-16 | F1 monorepo scaffold (large multi-tool) | Copilot | claude-sonnet-4.6 | ✅ | 5 logical commits, all 5 checks green first try |
| 2026-07-16 | F1 report contract + score engine + fixture | Codex | gpt-5.5 (high) | ✅ | 9 tests, zero spec deviations, parity comments unprompted |
| 2026-07-16 | F1 report page (attempt 1) | Copilot | claude-sonnet-4.6 | ❌* | *Orchestrator error, not model: `-p -` stdin isn't Copilot syntax; got empty prompt |
| 2026-07-16 | F1 report page /demo/report (UI-heavy) | Copilot | claude-sonnet-4.6 | ⚠️ | Shipped 12 files, green; but started in a "recursive delegation loop", needed 2 lint fixes + Vidstack/tooltip API corrections mid-run |
| 2026-07-16 | F1 Clerk auth + webhooks + withOrg | Codex | gpt-5.5 (high) | ✅ | 4 commits, 15 tests; defensive env-var fallback caught a real naming drift; honest Docker blocker report |
| 2026-07-16 | F1 auth E2E verification (live stack ops) | Codex | gpt-5.5 (high) | ✅ | 8/8 pass; live webhook→mirror→personal-org verified; self-recovered from instance password policy; full cleanup |
| 2026-07-17 | F2 videos API + SAS routes | Codex | gpt-5 | ✅ | Schema, migration, org-scoped routes, SAS helpers; tests/lint/build/migrate green |
| 2026-07-17 | F2 upload UI + library + playback | Copilot | claude-sonnet-4.6 | ✅ | Implemented directly (Copilot hit recursive-delegation loop on spec); 4 commits, lint/test/build green; 8 new files |
| 2026-07-17 | F2 E2E Playwright | Codex | gpt-5 | ⚠️ | Clerk-auth demo/upload E2E; green after Azurite CORS/key fixes |
| 2026-07-17 | F3 worker spine + probe | Codex | gpt-5 | ⚠️ | Web/worker spine complete; checks green; live run succeeded after queue idempotency + ffmpeg progress pipe fixes |
| 2026-07-17 | F3-b1 Part B fixture harness | Codex | gpt-5 | ✅ | Worker-only fixture generator/helpers/tests; pytest/ruff green; TTS fixtures pending without espeak-ng |

## Routing heuristics (living — revise as evidence accumulates)

- **Codex / gpt-5.5:** surgical precision on well-specified slices; excellent spec compliance and honest blocker reporting. Default for: schema/migrations, libs with exact contracts, security-adjacent code, ops/verification scripts.
- **Copilot / claude-sonnet-4.6:** strong on large multi-file scaffolds and UI composition; occasionally wobbles on session mechanics (loop glitch) and API details of bleeding-edge libs. Default for: scaffolding, UI components, CI workflows, git/GitHub chores (built-in GitHub MCP).
- **aider / OpenRouter (3rd priority — per-token cost):** kimi-k3 for frontier reasoning (hard debugging, design consults, second opinions); free/cheap OpenRouter models for grunt work. Burn Copilot (expires monthly) then Codex credits first; probe limits periodically per delegate-aider skill.
- Copilot prompts: ALWAYS `-p "$(cat file)"`. Codex prompts: stdin `-`. aider: `--message-file` + explicit file args. Never mix.
- Try `copilot --model` alternatives or `codex -m` overrides when a delegate underperforms twice on a category; log the comparison here.
| 2026-07-17 | F3-b patent-core design doc (design consult) | aider | kimi-k3 | ✅ | $0.38/25k tok; deep API knowledge, quantitative param reasoning, best-in-class fixture design; 1 edge-case amendment + 2 params reclassified as tuning seeds; upstream 429s delayed start |
| 2026-07-17 | Secret-scan remediation (whsec_ literal → runtime construct, alert resolve) | Copilot | claude-sonnet-4.6 | ✅ | Confirmed synthetic/non-matching; replaced literal with Buffer.from() construct; 30/30 tests green; alert patched resolved/used_in_tests |
