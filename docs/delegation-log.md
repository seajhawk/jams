# Delegation scorecard

Track every delegated run so we route work to whoever does it best. Update after each run (the delegate skills require it). Grade: ✅ clean · ⚠️ needed fixes/retry · ❌ failed.

| Date | Task | Delegate | Model | Grade | Notes |
|---|---|---|---|---|---|
| 2026-09-12 | Narrated E2E fixture inspection and spec | Codex subagent | gpt-5.6-luna | ⚠️ | Identified existing AV-sync reference and drafted narrated assertions before quota interruption; primary completed seek guard and verified real offline pipeline. |
| 2026-09-12 | Narrated E2E review | Codex subagent | gpt-6-astra | ✅ | No actionable findings in fixture, real-model assertions, completed seeking or runner isolation; primary executed E2E. |
| 2026-09-11 | Real pipeline browser spec and web regressions | Codex subagent | gpt-5.6-luna | ⚠️ | Implemented bounded tests; primary corrected API wrapper/selectors and integrated the live run. Final E2E passed and 138 web tests passed. |
| 2026-09-11 | Silent-video partial status | Codex subagent | gpt-5.6-luna | ⚠️ | Drafted pipeline/finalization changes before quota interruption; primary completed error precedence, regression tests, and real report verification. |
| 2026-09-11 | Pipeline E2E and discovered product fixes review | Codex subagent | gpt-6-astra | ✅ | Identified incomplete-seek assertion and subprocess cleanup issues; rereview accepted corrections, navigation/profile fixes, no-audio semantics, and unlabeled transition contract. Read-only; primary ran validation. |
| 2026-09-10 | Remaining setuptools vulnerability diagnosis | Codex subagent | gpt-5.6-luna | ✅ | Located CTranslate2's obsolete pkg_resources dependency and identified compatible 4.8.2; primary upgraded, audited clean, and passed all three cached-model transcription gates offline. |
| 2026-09-10 | Personal-org recovery race | Codex subagent | gpt-5.6-luna | ⚠️ | Added lock-timeout rejection and stable per-user slug before quota interruption; primary strengthened overlapping-request tests and verified 24 focused tests/build. |
| 2026-09-10 | Webhook integration review | Codex subagent | gpt-6-astra | ✅ | After usage reset, reviewed claims, transactional rollback, lease-owner release, migration backfill and tests; no release-blocking findings. Read-only review; validation run by primary. |
| 2026-09-10 | Build inventory and evaluation matrix | Codex subagent | gpt-5.6-luna | ✅ | Inventoried implemented features and experimental physical providers; primary updated release evidence after integration. |
| 2026-09-10 | JEM timing tails and false-positive exposure | Codex subagent | gpt-5.6-luna | ⚠️ | Implemented metrics and parameter validation; review corrected scored-window semantics; 16 targeted tests passed. |
| 2026-09-10 | Workspace dependency and build repair | Codex subagent | gpt-5.6-luna | ⚠️ | Root overrides, frozen install, audit and build repaired; primary subsequently removed stale nested lockfile exposed by CI. |
| 2026-09-10 | Integrated media-timebase review | Codex subagent | gpt-6-astra | ⚠️ | Found transport-origin and word-end defects; primary fixed both with regressions. Final rereview unavailable after usage limit. |
| 2026-09-10 | Narrated-click precision diagnosis | Copilot CLI | auto | ❌ | Hit 30-credit session cap without verification. Proposed speech margin still failed precision gate (0.06897 vs 0.85); primary reverted it. No detector change retained. |
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
| 2026-07-17 | F7 E2E weight-profile interference fix | Codex | gpt-5 | ✅ | Comparison fixture no longer seeds org default; default profile creation hardened for concurrent report assembly; E2E green twice |

## Routing heuristics (living — revise as evidence accumulates)

- **Codex / gpt-5.5:** surgical precision on well-specified slices; excellent spec compliance and honest blocker reporting. Default for: schema/migrations, libs with exact contracts, security-adjacent code, ops/verification scripts.
- **Copilot / claude-sonnet-4.6:** strong on large multi-file scaffolds and UI composition; occasionally wobbles on session mechanics (loop glitch) and API details of bleeding-edge libs. Default for: scaffolding, UI components, CI workflows, git/GitHub chores (built-in GitHub MCP).
- **ROUTING CHANGE (Chris, 2026-07-17):** Copilot is nearly out of credits — BENCHED until its monthly reset (July 31); route everything to Codex first, aider/OpenRouter second. Model overrides within each CLI are allowed and encouraged where they fit the task (`codex -m`, `copilot --model`, aider `--model openrouter/...`). **If Codex hits rate limits/exhaustion: STOP delegating and pause for Chris's decision — do not silently fall back.**
- **aider / OpenRouter (3rd priority — per-token cost):** kimi-k3 for frontier reasoning (hard debugging, design consults, second opinions); free/cheap OpenRouter models for grunt work. Burn Copilot (expires monthly) then Codex credits first; probe limits periodically per delegate-aider skill.
- Copilot prompts: ALWAYS `-p "$(cat file)"`. Codex prompts: stdin `-`. aider: `--message-file` + explicit file args. Never mix.
- Try `copilot --model` alternatives or `codex -m` overrides when a delegate underperforms twice on a category; log the comparison here.
| 2026-07-17 | F3-b patent-core design doc (design consult) | aider | kimi-k3 | ✅ | $0.38/25k tok; deep API knowledge, quantitative param reasoning, best-in-class fixture design; 1 edge-case amendment + 2 params reclassified as tuning seeds; upstream 429s delayed start |
| 2026-07-17 | Secret-scan remediation (whsec_ literal → runtime construct, alert resolve) | Copilot | claude-sonnet-4.6 | ✅ | Confirmed synthetic/non-matching; replaced literal with Buffer.from() construct; 30/30 tests green; alert patched resolved/used_in_tests |
| 2026-07-18 | F10 physical-effort design doc (design consult) | aider | kimi-k3 | ✅ | $0.41/27k tok; self-applied TUNE discipline, two-flash sync fix for Playwright timestamps, weight-0 graduation argument; 3 amendments (location honesty, no-audio semantics, SNR pin) |
| 2026-07-18 | Concepts/choices design doc (design consult) | aider | kimi-k3 | ✅ | $0.21/14k tok; RapidOCR determinism posture, dwell-driven frame selection, garbage-risk honesty; 5 OQ resolutions in review |
| 2026-07-20 | JEM project plan (design consult) | aider | kimi-k3 | ✅ | $0.34/22k tok; full 17-section build-ready plan, correct Win32/UIA/ffmpeg specifics, active-time+flash sync; 2 corrections in review (per-segment flash drift, ddagrab lavfi syntax) |
