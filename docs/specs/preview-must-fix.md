# Preview must-fix work (from the readiness review, PR #18)

Source: `docs/reviews/PREVIEW-READINESS-REVIEW-2026-09.md` on branch `preview-readiness-review`
(PR #18), section 3 "Must fix before inviting anyone", items B1 to B10. Chris asked (2026-09-26):
start on these, keep working on other things, and continue after each usage reset. Everything is
committed and pushed after it is validated, so Chris can pick up from his laptop.

## Ground rules

- One small PR per group below, each from `main` (not stacked on the U-series, which the review
  recommends holding until after the first 5 users). Never push `main`: pushing `main` deploys to
  staging. Chris merges.
- Claude implements directly while weekly usage is below 80% (`get_usage`), per `CLAUDE.md`.
- Validate before pushing: `pnpm exec tsc --noEmit -p .`, `pnpm lint`, `pnpm test` in `apps/web`
  (with local Postgres for integration tests), `uv run pytest` and `uv run ruff check` in `worker`
  when touched, and the relevant Playwright spec where feasible.
- Local Postgres 16 for integration tests: binaries in `D:\Temp\jams-e2e-tools\pgsql\bin`, data dir
  `C:\Users\chris\AppData\Local\Temp\claude\D--git-jams\2ee34531-fc5d-40a5-bb34-553fcfd4be24\scratchpad\pgdata`
  (user jams/jams, port 5432; start with `pg_ctl -D <dir> -o "-p 5432 -c listen_addresses=localhost" start`).
  Azurite for e2e: `node D:\Temp\jams-e2e-tools\azurite\node_modules\azurite\dist\src\azurite.js`.
  Docker is not installed, so Docker-seeded e2e specs only run in CI.

## Items and plan

| Item | What | Owner | Plan |
|---|---|---|---|
| B1 | Site renders in Times New Roman | Claude | Fixed in PR #19; add a Playwright assertion on the computed body font to that PR |
| B2 | Clerk production + real domain | Chris, then Claude | Chris picks the domain. Claude prep: parameterize Blob CORS `allowedOrigins` in `infra/resources.bicep` (keep the ACA default, add the custom domain), note `JAMS_PUBLIC_ORIGIN` and the watchdog `JAMS_APP_URL` in the runbook |
| B3 | Uninvited sign-ups dead-end at a raw 403 | Claude + Chris | Landing primary CTA "Request access"; styled invite-only page from `proxy.ts` with the same request link; contact from env `JAMS_CONTACT_EMAIL` (unset: "ask the person who invited you"). Chris: Clerk restricted/waitlist sign-up mode |
| B4 | Share links 404 for non-invited viewers | Chris decides, Claude builds | Share dialog states the rule plainly now; add env flag `JAMS_PUBLIC_SHARE_LINKS` (default off) that lets valid, unexpired, unrevoked tokens open without sign-in, with tests. Chris flips it if he chooses option (a) |
| B5 | Sample report broken and hand-made | Claude + Chris | Fix the copy (library card, report toast). Chris records a 2 to 4 min narrated task; Claude runs it through the pipeline and freezes it as the demo later |
| B6 | Report overclaims accuracy | Claude (patent-core design) | "Experimental" badge + one-line explanation by the Effort Score; stop mapping `spoken_word` to "Physical"; hide weight-0 kinds behind "Show experimental signals"; "narration sentiment" wording and "Strongly negative narration" instead of "Frustrated"; kinds with no coverage drop out of numerator and denominator and show "Not measured" (TS and Python parity, bump `SCORE_FORMULA_VERSION`), test that a silent recording's score does not fall; plain-word run status |
| B7 | No privacy, terms, contact | Claude drafts, Chris approves | `/privacy` (preview data handling) and `/terms` pages, public (not behind the preview gate), linked from a landing footer, sign-up and the upload dialog; business entity and contact as clearly marked placeholders |
| B8 | Account deletion leaves recordings | Claude + Chris | Wire `organization.deleted` (and a user's personal org) into the existing recording deletion lifecycle; runbook procedure. Chris: disable self-service deletion in Clerk for the preview if he prefers the manual route |
| B9 | Public repository | Chris | Decision only; note in the summary |
| B10 | Deploy does not wait for tests | Claude + Chris | Deploy runs only after CI succeeds on the same commit (`workflow_run`), plus a post-deploy smoke of `/api/health/live` and `/`. Chris: branch protection requiring the CI checks |

## Progress

- [x] B1 regression test on PR #19 (`e2e/typography.spec.ts`; fails on the old CSS with "Times New Roman", passes with the fix)
- [x] B6 honest report: PR #20 (branch `honest-report`; worker 203 + web 295 tests pass)
- [ ] B3 + B4 + B7 access and trust pages (own PR)
- [ ] B10 + B2 prep: deploy gating, smoke, CORS parameter (own PR)
- [ ] B8 deletion on account/org deletion (own PR)
- [ ] B5 copy fixes (with B3/B7 PR or own)
- [ ] Summary for Chris: what shipped, what needs him (B2, B9, Clerk settings, demo recording, legal wording)

## Other open work to keep an eye on

- PRs #13 to #16 (U-series, stacked; Auto-fix is on for them), #17 (tenancy/billing design),
  #18 (readiness review), #19 (font fix).
- The cloud session hardening against abuse (branch `hardening-abuse`) will open its own PR.
- Reply-and-resolve helper for review threads:
  `C:\Users\chris\AppData\Local\Temp\claude\D--git-jams\2ee34531-fc5d-40a5-bb34-553fcfd4be24\scratchpad\reply_resolve.sh PR COMMENT_ID "message"`.

## B6 design (Claude, patent-core; decided 2026-09-26)

Work on branch `honest-report` from `main`. Scoring changes must stay identical in
`worker/src/jams_worker/effort_score.py` and `apps/web/src/lib/effort-score.ts` (parity tests:
`worker/tests/test_effort_score.py`, the web effort-score tests, and `fixtures/demo-report.v1.json`).

1. **Speech is not physical.** `spoken_word` moves from category `physical` to `speech` in
   `KIND_CATEGORY` (both scorers). Physical then holds only clicks, keypresses and scrolls (weight 0
   by default), so the default report shows Physical as "Not measured".
2. **Not measured is not zero.** `normalize()` adds `measured: boolean` per kind:
   - `spoken_word`, `utterance`: measured iff the video has audio (`has_audio`); audio with no speech
     is a real 0, not missing.
   - `sentiment`: measured iff at least one `sentiment` measure exists (nothing to classify otherwise).
   - `context_switch`, `time_segment`: always measured. `clicks`, `keypresses`, `scrolls`: measured
     iff at least one measure of that kind exists.
   `score()` uses only kinds with weight > 0 AND measured, in both numerator and denominator. A
   category with no such kind is `null` ("Not measured"); `total` is `null` if nothing is active.
3. **Storage and contract.** `effort_scores` integer columns stay NOT NULL (0 when not measured);
   `breakdown` gains `measured` per kind and a `components_measured` map. `report-contract.ts`
   components and total become `number | null`; report assembly maps not-measured to `null` from the
   breakdown. Old stored rows without `measured` are treated as measured (unchanged rendering).
   Bump `SCORE_FORMULA_VERSION` in `effort_score.py` (it feeds the U1 fingerprint once merged).
4. **Tests.** A silent recording (no audio, no utterances) scores the same total as the same
   measures without the speech kinds, never lower because of zeros; parity between Python and
   TypeScript on the demo fixture and on a silent fixture; spoken_word contributes to speech, not
   physical.
5. **UI.** "Experimental" badge next to the Effort Score dial with one line ("A relative indicator
   for comparing sessions of the same task. Not a validated measure of workload."); components show
   "Not measured" for null; weight-0 kinds hidden in the Measures tab and timeline behind "Show
   experimental signals"; wording: "narration sentiment", and "Strongly negative narration"
   instead of "Frustrated" in Highlights (`report-moments.ts`); plain-word run status instead of
   "succeeded"/"partial".
