# Private preview readiness review

September 26, 2026. Reviewed at `main` 881023b, plus open PRs #13 to #16 (the U-series), the
unpushed local branch `design-tenancy-auth-billing` (8fea612, `docs/design/tenancy-auth-billing.md`)
and the public pages of the staging site. This is a review only: no application code, settings or
secrets were changed, and no account was created.

The question it answers is Chris's: what would make an early user think JAMS is junk or a joke, and
what has to change before that user arrives?

## 1. Verdict

**Not ready to invite anyone yet, but close.** The engineering underneath is better than what a
visitor sees: tenant isolation with RLS, sealed uploads, a real deletion lifecycle, fenced worker
recovery, honest retry banners and a CI suite that now runs its accuracy gates. The problems are on
the surface, and most of them are small. The three that matter most:

1. **The first screens look unfinished.** Every page renders in Times New Roman because of a
   one-line CSS bug. The sign-up card says "Development mode". The favicon is the Next.js default.
   The landing page never says who JAMS is for, and the sample report has no video and says uploads
   "are being built". A visitor decides in seconds, and these are the seconds.
2. **The numbers claim more than has been measured.** The Effort Score has no "experimental" label,
   yet 70% of its default weight sits on context switches (F1 0.14 to 0.57 on real human footage)
   and a sentiment model that was replaced this week and has never been measured on human narration.
   "Physical effort" is actually words spoken per minute. Clicks with 11% precision are listed with
   confidence percentages. Silent recordings score as easier. One obviously wrong number on a user's
   own recording is exactly the "it's a joke" moment.
3. **The trust basics are missing, and one of them gets harder to fix every day you wait.** There is
   no privacy statement, terms, contact address or data-handling page for a product that ingests
   screen recordings. Deleting an account leaves the recordings behind. And the preview runs on a
   Clerk development instance: production has different user and organization ids, and every
   tenant row is keyed on the Clerk org id, so anyone invited before the switch will lose their data
   or need a migration. Switch first, then invite.

## 2. What was reviewed, and assumptions

- Docs: `AGENTS.md`, `docs/PLAN.md`, `docs/ACCURACY-PROGRAM.md`, `docs/EVALUATION-MATRIX.md`,
  `docs/PREVIEW-READINESS.md`, `docs/PILOT-RELEASE.md`, `docs/OPERATIONS-RUNBOOK.md`,
  `docs/CHRIS-TODO.md`, `docs/PIPELINE-PERF-2026-09-19.md`,
  `docs/reviews/PRE-LAUNCH-REVIEW-2026-09-23.md`, `docs/design/customer-journeys-ux.md` (from the
  U1 branch), the U1 to U4 specs, and the unmerged `seajhawk-private-pilot-playbook` branch.
- Code: `apps/web` (landing, auth pages, app shell, library, upload dialog, report, share, settings,
  demo, `proxy.ts`, scoring), `infra/*.bicep`, `.github/workflows/*`.
- Live staging, public pages only: `/`, `/sign-up`, `/sign-in`, `/demo/report`, `/robots.txt`,
  an invalid share token, and response headers.
- **Tenancy, sign-in and billing plan:** found on the local branch `design-tenancy-auth-billing`
  (not pushed). Read and referenced below as "the tenancy design".
- **Abuse hardening:** the `hardening-abuse` branch exists locally but has no commits beyond `main`.
  This review assumes nothing from it has landed and relies on the tenancy design's section 6.4 for
  the planned controls.

## 3. Must fix before inviting anyone

Effort: S is under half a day, M is one to three days, L is longer. Owner: "Claude" means Claude can
build it; "Chris" means a decision, an account, a setting or something only Chris can do.

### B1. The whole site renders in Times New Roman

- **Finding:** `apps/web/src/app/globals.css` line 26 is `--font-sans: var(--font-sans);`, a
  self-reference, so the variable is invalid and the browser falls back to its default serif. On the
  live landing page the computed `font-family` of `body` and `h1` is `"Times New Roman"`, while
  `--font-geist-sans` is correctly loaded and unused.
- **User impact:** every page, including the report, looks like an unstyled 1990s page. This alone
  reads as "weekend project".
- **Smallest fix:** `--font-sans: var(--font-geist-sans);` and a Playwright assertion on the
  computed body font so it cannot regress. Check whether Chris's uncommitted local `globals.css`
  experiment (listed in `CHRIS-TODO.md`) is the source.
- **Effort / owner:** S / Claude.

### B2. Clerk production instance and a real domain, before the first invite

- **Finding:** staging uses a Clerk development instance (`x-clerk-auth-reason: dev-browser-missing`
  on every response; the sign-up card shows an orange "Development mode" label; social login
  consent screens use Clerk's shared OAuth apps). The pre-launch review lists this as the top
  go-live blocker, still waiting on a domain.
- **User impact:** a visible "Development mode" badge on the first form a user fills in. Worse,
  development and production instances have different user and org ids, and `org_id` is the tenant
  key on every row, so any account created now is stranded after the switch.
- **Smallest fix:** Chris buys the domain; then bind it to `jams-web` with a managed certificate,
  add Clerk's DNS records, create Google and GitHub OAuth apps, set the production keys (the
  publishable key is compiled into the web image as a build argument), and point the Clerk webhook
  at the new host. Three other places hard-code today's host and must change in the same step:
  - the Blob CORS rule in `infra/resources.bicep` (`allowedOrigins` is the default ACA domain; on
    a custom domain every browser upload fails with a bare "Failed to fetch"),
  - `JAMS_PUBLIC_ORIGIN` for share links (`lib/public-origin.ts`),
  - the `JAMS_APP_URL` variable used by `.github/workflows/watchdog.yml`.
- **Effort / owner:** M / Chris (domain, Clerk, OAuth apps) then Claude (Bicep CORS parameter,
  env wiring, end-to-end verification).

### B3. Uninvited sign-ups hit a dead end; invited ones need a redeploy

- **Finding:** the landing page's primary button is "Create account". Anyone can complete Clerk
  sign-up, is redirected to `/library`, and gets an unstyled raw-HTML 403 page from `proxy.ts`
  ("JAMS private preview ... invitation-only"). There is no way to ask for access, and Chris is not
  told who tried. For an invited person, admission is by exact Clerk user id in
  `JAMS_PREVIEW_USER_IDS`: they must sign up first, Chris looks up their id, edits the variable, and
  redeploys (`infra/main.bicep` parameter).
- **User impact:** LinkedIn visitors who click through feel tricked; invited people wait on a deploy.
- **Smallest fix:** in the production Clerk instance, restrict sign-up to invitations (Clerk's
  restricted or waitlist sign-up mode; confirm what the plan includes) and invite by email from the
  Clerk dashboard. Change the landing button to "Request access" (a Clerk waitlist, or a mailto on
  the new domain). Give the 403 page the app's styling and the same "request access" link. Later,
  move the allowlist out of an environment variable (the tenancy design's `JAMS_ACCESS_MODE`, P2)
  so inviting never needs a deploy.
- **Effort / owner:** S to M / Chris (Clerk mode) and Claude (landing, 403 page).

### B4. Shared reports show "page not found" to anyone who is not an invited user

- **Finding:** `apps/web/src/app/share/[token]/page.tsx` calls `notFound()` when the preview gate
  is on and the viewer is not on the allowlist. `ShareReportDialog.tsx` does not mention this.
- **User impact:** a preview user shares their first report with a manager, and the manager sees a
  404. Sharing evidence is the product's viral loop and the moment of value; this makes it look
  broken.
- **Smallest fix (Chris decides):** (a) recommended: let valid, unexpired, unrevoked share tokens
  open without sign-in during preview. They are 43-character random tokens, expire, can be revoked,
  and are `noindex`. Or (b) keep the rule and say it plainly in the share dialog ("During the
  private preview, only invited accounts can open this link").
- **Effort / owner:** S / Chris decides, Claude builds.

### B5. The sample report is broken, mismatched and not real

- **Finding:** `/demo/report` plays `/demo.mp4`, which is gitignored and generated only by
  `pnpm demo:video`; the web `Dockerfile` copies `public/` without it, so the deployed player has
  no video. The library card calls it "Google Video Analyzer setup" and says "Review the seeded
  report while uploads are being built" (`LibraryContent.tsx` line 791); the report itself is
  "Participant 3 - Azure Python deployment walkthrough", 14 minutes; `ReportShell.tsx` shows a
  toast "Demo report, upload your own video soon". The numbers in
  `fixtures/demo-report.v1.json` were hand-authored for F1, not produced by JAMS.
- **User impact:** the first thing a new user is told to open is a report with a dead player and
  copy that says the product is not built yet. For a measurement product, a sample whose numbers
  were typed by hand is also a credibility trap if anyone notices the video and the numbers do not
  match.
- **Smallest fix:** Chris records a 2 to 4 minute narrated task with no private data (15 minutes of
  his time). Run it through the real pipeline, freeze the export as the demo payload, host the
  video with the app (or in a public-read demo container), and fix the three pieces of copy.
- **Effort / owner:** M / Chris records, Claude wires.

### B6. Say what is measured, what is experimental, and what was not measured

The accuracy evidence (`ACCURACY-PROGRAM.md` sections 3.3, 3.5, 3.6) against what the report shows:

| Signal | Evidence on real human footage | What the report shows today |
|---|---|---|
| Context switches | F1 0.35, 0.57 and 0.14 on three sessions; timing p95 313 ms against a 250 ms gate | Weight 3 of 10 in the default score, timeline dots, Highlights rows, no caveat |
| Narration sentiment | Old model flagged 10 of 24 upbeat lines as frustration; the three-class replacement (Sept 25 to 26) has not been measured on human speech | Weight 4 of 10, "Frustrated" labels, no caveat |
| Spoken words per minute | Transcript near-verbatim on one 98 s session | Shown as **"Physical"** effort in the header (`KIND_CATEGORY` maps `spoken_word` to physical) |
| Clicks | 84 detections for 14 clicks (precision 0.11) | Weight 0, but listed in the Measures tab with a confidence percentage |
| Scrolls, keypresses | Recall 0 on every real session | Same: weight 0, listed with confidence |
| Effort Score | "No current accuracy claim is justified" (`EVALUATION-MATRIX.md`) | Big dial, red/amber/green, no label |

- **User impact:** a user who talks a lot sees high "physical effort"; a calm narrator can still get
  "Frustrated" rows; a silent recording looks easy; the Measures tab lists dozens of clicks that did
  not happen. Any one of these on the user's own recording undermines everything else.
- **Missing signals become zeros.** In `apps/web/src/lib/effort-score.ts`, `score()` keeps every
  weighted kind in the denominator and a recording with no narration gets a negative-share of 0 and
  a words-per-minute of 0, so silent recordings score lower (easier). `PILOT-RELEASE.md` step 3 makes
  "unavailable data must not become a zero measurement" an exit criterion; it is not met.
- **Smallest fix:**
  1. An "Experimental" badge next to the Effort Score dial, with one line: "A relative indicator for
     comparing sessions of the same task. Not a validated measure of workload."
  2. Rename or hide the "Physical" header component until a physical provider graduates; words per
     minute is speech, not physical effort. (Category mapping is patent-core: Claude designs it,
     mirrored in the worker for parity.)
  3. Hide weight-0 kinds (clicks, keypresses, scrolls) from the Measures tab and timeline by default,
     behind "Show experimental signals".
  4. Say "narration sentiment" everywhere, and rename "Frustrated" to "Strongly negative
     narration", as `PLAN.md` risk 5 already intends.
  5. Drop kinds with no coverage from both the numerator and the denominator, show them as "Not
     measured", and add a test that a silent recording's score does not fall.
  6. Replace the raw status badge ("succeeded", "partial") with plain words.
- **Effort / owner:** M / Claude (items 2 and 5 are patent-core design, so Claude designs them per
  `CLAUDE.md`).

### B7. No privacy statement, terms, contact or data-handling page

- **Finding:** nothing in `apps/web/src/app` for privacy, terms, contact or support; the landing
  page has no footer; the sign-up card has no terms link; `/privacy` and `/terms` return the
  preview 403. The stale pilot playbook branch lists `support@jams.dev` (a domain nobody has
  confirmed owning) and the retired DistilBERT model, so do not reuse its text as-is.
- **User impact:** a researcher is asked to upload screen recordings, often showing customer data
  and other people's voices, with no idea where they go, who can see them, or how to get them
  deleted. B2B buyers stop here.
- **Smallest fix:** one plain-language "Preview data handling" page and short preview terms, linked
  from the landing footer, the sign-up page and the upload dialog:
  - **Stored:** original video, a normalized copy, extracted audio, transcript, measures and scores.
  - **Where:** Microsoft Azure, East US 2 (Blob Storage and PostgreSQL). Sign-in by Clerk (US).
  - **Who sees it:** you; anyone you send a share link to; Chris as operator, only for support and
    debugging (say so).
  - **What does not happen:** no model training on your data; transcription and sentiment models run
    inside JAMS's own container; the optional LLM segment naming is off.
  - **Retention and deletion:** kept until you delete it; what deletion removes and how fast
    (`DELETION-LIFECYCLE.md`); how to delete your account (see B8).
  - **Terms:** preview is provided as-is with no uptime promise; you must have consent from anyone
    recorded; do not upload passwords, payment data or health data; feedback may be used to improve
    JAMS. A contact address on the new domain.
- **Effort / owner:** M / Claude drafts, Chris approves (legal wording and the business entity are
  his call).

### B8. Deleting an account leaves the recordings behind

- **Finding:** Clerk's `<UserButton>` offers self-service account deletion by default. The
  `user.deleted` and `organization.deleted` webhooks only set `deleted_at`
  (`apps/web/src/lib/clerk/mirror-store.ts`, `markUserDeleted`, `markOrgDeleted`); videos,
  transcripts, measures, share links and blobs remain.
- **User impact:** a user who deletes their account believes their recordings are gone. They are
  not, which contradicts the privacy page B7 needs to write.
- **Smallest fix:** for the preview, turn off self-service deletion in Clerk and state "email us to
  delete your account"; run the existing per-recording deletion for each of the org's videos by
  script. Afterwards, wire org deletion into the recording deletion lifecycle.
- **Effort / owner:** S (manual procedure) or M (automated) / Chris (Clerk setting), Claude.

### B9. The repository is public (decision)

- **Finding:** `seajhawk/jams` is public. It contains the staging URL (`watchdog.yml`, several
  docs), `CHRIS-TODO.md`, candid accuracy numbers, cost notes, notes that Azure was provisioned
  "while he slept", delegation logs, and the patent-core provider code.
- **User impact:** a LinkedIn announcement sends curious people to Chris's GitHub profile. They will
  find the "unannounced" website, read internal notes out of context, and see weaknesses before the
  product has a chance. The slow ramp does not work while the URL is public.
- **Smallest fix (Chris decides):** make the repository private before the post (check GitHub
  Actions minutes and that the GHCR pull token still works), or deliberately curate it.
- **Effort / owner:** S / Chris.

### B10. A push to `main` deploys straight to users, without waiting for tests

- **Finding:** `main` has no branch protection. `.github/workflows/azure-dev.yml` runs on every push
  to `main` and does not depend on the CI jobs, and there is no post-deploy smoke check. Staging is
  the only environment, so it is also where preview users will be.
- **User impact:** the stacked U-series (about 13,500 lines and migrations 0015 to 0017) or any
  hurried fix lands directly on live users, even if tests fail.
- **Smallest fix:** require the Web, Worker and Browser e2e checks on `main` (Chris, repository
  setting); make the deploy wait for them (`workflow_run` or a combined workflow); add a post-deploy
  check of `/api/health/live` and the landing page.
- **Effort / owner:** S / Chris (setting), Claude (workflow).

## 4. Should fix before the LinkedIn post

### S1. Landing page that answers "what, for whom, why believe it"

- **Finding:** `apps/web/src/app/page.tsx` is a title, one sentence, and three cards, one of which
  is "Tenant scoped by default: each signed-in user starts in a hidden personal workspace"
  (engineering jargon). No picture of a report, no audience, no mention of the patent, no footer.
  The name is never expanded. `layout.tsx` metadata has only a title and description, so a LinkedIn
  link unfurls as a bare "JAMS". `public/` still holds the create-next-app files (`next.svg`,
  `vercel.svg`, `globe.svg`, `file.svg`, `window.svg`) and `favicon.ico` is the Next.js default.
- **Smallest fix:** a headline naming the audience (UX researchers, product managers and
  documentation teams who watch recordings of people using their product); three steps (record a
  narrated task, upload, jump straight to where it got hard); a real report screenshot or short
  looping clip from B5; an honest "what JAMS measures today" line with experimental signals named;
  a factual patent line ("Built on U.S. Patent No. ..."; Chris supplies the number, and it should
  not imply the patent validates accuracy); "Request access"; a footer with privacy, terms,
  contact and who is behind it. Add Open Graph and Twitter metadata with an image, a real favicon
  and logo, and delete the template files.
- **Effort / owner:** M / Claude builds; Chris supplies positioning, patent number and approves.

### S2. Make the sample report public

- **Finding:** `/demo/report` sits under `(app)` and is blocked by both sign-in and the preview gate
  (live: 403).
- **Smallest fix:** after B5, move it outside the authenticated group and add it to the public
  routes, so a LinkedIn visitor can explore a real report without signing up. Link it from the
  landing page.
- **Effort / owner:** S / Claude.

### S3. Teach the first recording, and offer one to users who have none

- **Finding:** the upload dialog says only "MP4, MOV, WebM, M4V, max 20 min / 2 GiB". Nothing says
  what to record, that narration matters, how long, or which tool. JEM is not needed (any screen
  recording with a microphone track works), but nothing says that either.
- **User impact:** users upload silent or 20-minute recordings, wait a long time, and get a partial
  report that looks empty.
- **Smallest fix:** a "How to record" panel in the empty state and upload dialog: pick one task,
  2 to 5 minutes, think aloud, use test data, get consent; tool tips for Windows (Snipping Tool or
  Xbox Game Bar with microphone on), macOS (Screenshot toolbar with a microphone selected), OBS or a
  Loom download. Add an "Analyze a sample recording" button that copies a consented sample into the
  user's workspace and runs it, so a user gets a real report of their own in minutes without
  recording anything.
- **Effort / owner:** S for the panel, M for the sample button / Claude, Chris reviews copy.

### S4. Honest waiting: ETA, benchmark, and "we'll tell you when it's done"

- **Finding:** `apps/web/src/lib/eta.ts` estimates total time as about 0.56 times the video length
  and its header claims "Measured benchmark on 2-vCPU ACA SKU: RTF 0.14", but `PREVIEW-READINESS.md`
  and `CHRIS-TODO.md` say the Whisper benchmark on the real SKU was never run. The only measured
  real run took 2.08 times realtime before the encoder change (`PIPELINE-PERF-2026-09-19.md`); the
  improvement is an unconfirmed estimate, and no narrated recording longer than 98 s has been timed.
  Completion notices are in-tab toasts and desktop notifications only (`AnalysisWatcher.tsx`); close
  the tab and nobody tells you.
- **Smallest fix:** run `scripts/ops/pipeline-perf.sh` on narrated 1, 5 and 15 minute recordings
  (the tenancy design asks for the same numbers for pricing); calibrate the ETA and fix the comment;
  tell users "you can close this tab" only if an email follows. Email needs a sending service
  (Azure Communication Services inside the existing subscription is one option), which is Chris's
  call; until then say "keep this tab open or come back later".
- **Effort / owner:** M / Claude benchmarks and calibrates; Chris decides on email.

### S5. Know about failures before users tell you

- **Finding:** `infra/*.bicep` defines no alert rules and no budget. The runbook's alerts
  (`cleanup_failed_count`, overdue sweeps) are described, not implemented. The watchdog is driven by
  a GitHub Actions cron (which GitHub may delay or skip) and, per `CHRIS-TODO.md`, by a hand-made
  `jams-watchdog` Container Apps job that is not in Bicep. Log Analytics has a 1 GB/day cap, which
  silently stops ingestion under a spike. No error tracking.
- **Smallest fix:** an Azure budget alert (Chris, portal, 10 minutes); Azure Monitor alerts emailing
  Chris on web 5xx rate, worker job failures, failed analyses and watchdog failures; codify the
  watchdog job in Bicep and keep one scheduler; a daily digest of failed or partial runs.
- **Effort / owner:** M / Claude (Bicep), Chris (budget, alert recipient).

### S6. Cold starts and capacity

- **Finding:** `jams-web` runs at `minReplicas: 0`, `maxReplicas: 1`. After a few idle minutes the
  first visitor waits for a container to boot. `PLAN.md` itself says to flip to 1 "at first external
  users" (about $10 to $15 a month). The worker allows 3 concurrent analyses in total and 2 per org.
- **What breaks at 10x and 100x:** the landing page is prerendered and cached, so a LinkedIn spike
  on `/` is fine even on one replica. Sign-ups are the pressure point, and B3 handles them. For
  analyses, ten users uploading 5-minute recordings at once queue behind 3 workers, and the last
  waits roughly an hour at today's measured speed. At 100x, open sign-up without quotas is the risk,
  and it is covered by the tenancy design's phases P2 and P5. Note that removing
  `JAMS_PREVIEW_USER_IDS` today also removes every usage limit (`PREVIEW-READINESS.md`), so the gate
  must not be removed before P2.
- **Smallest fix:** `minReplicas: 1`, `maxReplicas: 3` (3 x 10 pool connections plus the worker stay
  under the B1ms limit of 50); keep worker concurrency at 3 for the preview; show "queued behind N
  analyses" when queued.
- **Effort / owner:** S / Chris approves the cost, Claude edits Bicep.

### S7. Security headers

- **Finding:** the landing response has no `Strict-Transport-Security`, `Content-Security-Policy`,
  `X-Frame-Options` or `Referrer-Policy`, and sends `x-powered-by: Next.js`. Only `/share` sets
  `X-Robots-Tag` (`next.config.ts`).
- **Smallest fix:** add a baseline set in `next.config.ts` (HSTS, `frame-ancestors 'none'`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `nosniff`, `poweredByHeader: false`), then a
  CSP that allows Clerk and the Blob origin. A security-minded buyer will check these.
- **Effort / owner:** S / Claude.

### S8. Branded error and not-found pages

- **Finding:** no `error.tsx`, `global-error.tsx` or `not-found.tsx`; an uncaught error shows
  Next.js's default "Application error" screen, and bad links show its default 404.
- **Smallest fix:** add the three files with the app's styling, a retry, and a "report this" link
  that feeds S9.
- **Effort / owner:** S / Claude.

### S9. A feedback loop Chris can actually read

- **Finding:** no feedback button, no product analytics, no error tracking.
- **Smallest fix:** (1) a "Send feedback" item in the header that writes to a `feedback` table shown
  on `/admin`, with the page URL and run id attached; (2) a thumbs up or down on each Highlights row
  ("Was this a real moment of friction?"), which also produces the human labels the accuracy program
  needs for sentiment and context switches; (3) a first-party events table with no cookies and no
  third party: signed in, upload started, completed or failed, analysis succeeded, partial or failed
  with duration, report opened, highlight played, share created, share opened, export; and a funnel
  view on `/admin`. That answers "where do people get stuck" without a cookie banner.
- **Effort / owner:** M / Claude.

### S10. Limits users can see

- **Finding:** a "Free" badge is hard-coded in `AppShell.tsx` and `settings/page.tsx`, implying a
  pricing tier that does not exist. The preview limits (100 analyses, 10 GiB, 2 at a time) are not
  shown anywhere, and hitting one returns "Preview analysis limit reached".
- **Smallest fix:** replace "Free" with "Private preview"; show usage against the limits on
  Settings; make the limit messages say what to do ("Delete a recording or email us for more").
  The tenancy design section 6.3 already specifies the long-term version.
- **Effort / owner:** S / Claude.

### S11. Decide what to do with the U-series (PRs #13 to #16)

- **Finding:** projects, goals, journeys, group comparisons, hotspots and findings are well tested
  and green, but they turn the weakest signals into the most confident sentences: "Frustration in 7
  of 10 sessions" from narration sentiment, and "B takes less effort than A: median 20 lower (95%
  range ...)" from an Effort Score with no validity study. The bootstrap interval covers sampling
  noise only, not measurement error. First users will have one to three recordings, below the
  5-session guidance, so the portfolio views will mostly be empty or show small-sample notes.
- **Recommendation:** do not merge before wave 1. Merge before wave 2 only after B6's labels reach
  hotspots, leaderboards and findings ("based on narration sentiment, experimental"), and after B10
  so the three migrations do not land untested on live users. Holding is safe: the U1 migration
  backfills existing tasks and labels.
- **Effort / owner:** M / Chris decides, Claude extends the labels.

### S12. Internal vocabulary in the product

- **Finding:** "Run history", "Run A, Baseline" and "Run B, Comparison" (compare pages), raw status
  words, "Untitled task", and "Tasks" in the nav while the design doc speaks of journeys and
  sessions.
- **Smallest fix:** "Analysis history", "Recording A / Recording B", plain statuses, and hide the
  task name when there is none.
- **Effort / owner:** S / Claude.

### S13. Name, trademark and patent notice

- **Finding:** the acronym is expanded four different ways: "Journey & Task Effort Analysis"
  (`readme.md`), "Journey/Task Effort & Sentiment Analysis" (`PLAN.md`), "Journey and task effort
  analysis" (landing), "Effort analysis" (app shell). "JAMS" is also the name of a large, well-known
  U.S. arbitration and mediation company, which dominates search results for the word and holds
  registered marks. The product never mentions the patent.
- **Smallest fix:** pick one expansion or a descriptor ("JAMS Effort Analytics") and use it
  everywhere; do a trademark knockout search before the public announcement; add a factual patent
  line and a `/patents` page (virtual marking).
- **Effort / owner:** S / Chris decides; Claude applies.

### S14. Accessibility basics

- **Finding:** the report header shows scores coloured red, amber or green with no text band; the
  Measures tab, timeline and transcript have no ARIA labels; the pre-launch review lists Base UI
  `nativeButton` warnings on every link-button.
- **Smallest fix:** add text bands ("low", "medium", "high") next to colours, run axe-core in the
  Playwright suite on landing, library and report, and fix critical findings.
- **Effort / owner:** M / Claude.

### S15. Rehearse a restore, and check what is already in staging

- **Finding:** the runbook's exit criteria include a backup restore rehearsal that has not happened.
  The environment previews will use is the one used for experiments: `PIPELINE-PERF` calls the Email
  Review session "the slow staging run", while `ACCURACY-PROGRAM` says that session, which shows
  Chris's real mailbox, is processed on the local stack only. One of the two is wrong.
- **Smallest fix:** confirm and delete any sensitive recordings from staging; after the Clerk switch,
  purge the stranded development-instance orgs through the deletion lifecycle; do one
  point-in-time restore into a scratch server and write down how long it took.
- **Effort / owner:** S to M / Chris (Azure portal), Claude (scripts).

## 5. Nice to have

| # | Item | Evidence | Effort / owner |
|---|---|---|---|
| N1 | Hash share tokens at rest | Pre-launch review, recommended | M / Claude |
| N2 | Postgres private endpoint instead of `AllowAllAzureServices` | `infra/resources.bicep` | M / Claude, Chris approves cost |
| N3 | Managed identity for Storage and Postgres | Deferred by Chris, `CHRIS-TODO.md` | M / Claude |
| N4 | In-app incident banner driven by one environment variable, instead of a status page | None today | S / Claude |
| N5 | Notification watcher scoped to the current user's runs | Pre-launch review | S / Claude |
| N6 | Weight profile API `.max(10)`; migrate off deprecated `createRouteMatcher` | Pre-launch review | S / Claude |
| N7 | Mobile pass on report and library (sidebar hides below `md`) | `AppShell.tsx` | S / Claude |
| N8 | Blob soft delete or versioning decision, written down alongside the deletion guarantees | `infra/resources.bicep` | S / Chris |
| N9 | Do not merge the Sept 5 pilot playbook as-is (stale model, unowned support address) | `seajhawk-private-pilot-playbook` | S / Chris |

## 6. What is already good (keep it)

Tenant isolation through `withOrg` plus RLS on every tenant table with a catalog test; server-owned,
sealed uploads; a recording deletion lifecycle with verified cleanup; a fenced, self-healing worker
queue; partial and failed runs that explain themselves and offer one-click retry; CI that runs the
real accuracy gates and a real upload-to-report browser test; deep links that land within 250 ms;
keyboard shortcuts in the report; honest small-sample language already built into the U2 code. The
fixes above are mostly about making the surface match this.

## 7. Suggested preview plan

**Wave 0: rehearsal (this week, 2 people).** Chris plus one trusted colleague, on the production
Clerk instance and the new domain, after B1 to B10. Run the checklist in section 8 end to end,
including a share to someone who is not invited, a deletion, and an account-deletion request.

**Wave 1: supervised (5 people, 2 weeks).** People who match the buyer hypothesis in
`PILOT-RELEASE.md`: UX researchers, product managers or documentation leads who already watch
recordings of users. Lower the per-org limits for the preview (for example 20 analyses and 5 GiB).

- **Kickoff (30 minutes, screen share).** Watch them sign in, read the landing page and upload
  without help. That session is the usability test; take notes, do not rescue them unless stuck.
- **Ask them to** record two or three narrated, 2 to 5 minute sessions of one real task in their own
  product using test data: ideally the same task by two people, or before and after a change.
- **Debrief (20 minutes).** For each highlight: was it real? What did JAMS miss? Would you forward
  this report to justify a fix? What would you pay for, and who would approve it?
- **Measure:** time from invite to first report; share of uploads and analyses that succeed first
  time; analysis minutes per video minute; highlight agreement rate from the thumbs (S9); number of
  "clearly wrong" numbers reported; shares created and opened; return visits within 7 days; asks for
  a second study.

**Widen to wave 2 when all hold:** no open blockers for a week; at least 90% of analyses succeed on
the first try; nobody reported an obviously wrong headline number that the UI did not already
caveat; at least 3 of 5 found a highlight they agreed was real friction; at least 2 asked to run
another study; an alert has fired and been handled at least once.

**Wave 2: the LinkedIn post (15 to 30 people from the request-access list, unsupervised).** The
post links to the landing page and the public sample report, not to sign-up. Invite in batches of
five a few days apart, watching the funnel view and failure alerts between batches. Merge the
U-series here, if S11's conditions are met.

**Wave 3: open sign-up.** Only after the tenancy design's P2 (plan quotas that do not depend on the
preview allowlist) and P5 (global free budget, cost alerts, retention sweeps, terms). Until then,
`JAMS_PREVIEW_USER_IDS` must stay set, because removing it also removes every usage limit.

## 8. Checklist for the day before sharing

1. Open the landing page in a private window on a phone and a laptop: Geist font, real favicon, no
   "Development mode", "Request access" works, footer links resolve.
2. Paste the URL into a LinkedIn post draft: the preview card shows a title, description and image.
3. Open the public sample report: the video plays, highlights jump and play audio, and the copy does
   not say "soon" or "being built".
4. Try to sign up with an uninvited email: you are sent to request access, not to a raw 403 page.
5. Sign in as an invited test account: upload a 2-minute narrated recording and a silent one. Both
   finish; the ETA was roughly right; the silent one says "not measured" instead of scoring lower.
6. In the report: the Effort Score shows "Experimental"; no "Physical" number comes from speech;
   clicks, keys and scrolls are hidden by default; sentiment is called narration sentiment.
7. Create a share link, open it in a private window without signing in, then revoke it and confirm
   it stops working.
8. Delete a recording; confirm the report, share link and playback return 404. Walk through the
   account-deletion instructions on the privacy page.
9. Send a feedback message and a highlight thumbs-down; see both on `/admin`.
10. Check alerts: trigger a test failure and confirm the email arrives. Confirm the budget alert.
11. Confirm `main` requires CI and that the last deploy's smoke check passed; do not merge anything
    the day of the post.
12. Confirm the repository visibility decision (B9) is done, and that the staging URL is not in
    anything public.
13. Confirm the preview limits and the invited list are what you intend, and that the privacy page
    matches what the system really does.
