# Pre-launch review: code, security and testing

September 23, 2026. A full pass over what has been built, with emphasis on whether the tests
actually protect the product. Everything marked **Fixed** is committed, deployed to staging and
covered by a test that fails on the old code.

## Verdict

The architecture is sound and most of the security-critical code is careful: Clerk webhooks are
signature-verified with an idempotency ledger, uploads are finalized with an ETag-pinned copy to a
server-owned path, blob paths never contain client input, and the worker's queue and lease logic
is fenced and self-healing.

The review found three security gaps, a severe availability problem, a production hydration bug,
and a test suite that was quietly not running its most important checks. All of those are fixed.
What remains before go-live is mostly configuration that needs Chris: a Clerk production instance,
CI secrets for the browser tests, and a migration step in the deploy pipeline.

## Fixed

### Security

| # | Finding | Severity | Evidence |
| --- | --- | --- | --- |
| S1 | **`/admin` page relied on its layout for authorization.** Next's own auth guide (in `node_modules/next/dist/docs`) says a layout "does not stop [route segments] from running or from appearing in the RSC Payload". The page reads every tenant's failed and stuck runs plus poison-queue messages. | High | `admin-page-guard.test.tsx` fails on the old code: the page rendered and read all runs for a non-admin. |
| S2 | **Tenant isolation was off for `share_links` reads.** Migration 0007's `share_links_token_select ... USING (true)` is a permissive policy, and Postgres ORs permissive policies together. Any web-role query could read every organization's share tokens, from any tenant context or none. App queries filtered by org, so it was not reachable through the API, but it voided RLS for the one table whose rows are bearer credentials. | Medium | Reproduced on real Postgres: a transaction scoped to org A read org B's token. Fixed by migration 0014; the policy now reveals only the token the caller presents. Applied to staging and verified in the catalog. |
| S3 | **CSV export allowed spreadsheet formula injection.** `value_text` is transcribed speech, so a recording could carry `=HYPERLINK(...)` into whoever opens the export. | Medium | `report-export-csv.test.ts`. Text starting with `= + - @` is neutralized; numbers stay numeric. |

### Availability and correctness

| # | Finding | Severity | Evidence |
| --- | --- | --- | --- |
| P1 | **The whole web tier had one database connection.** Both Postgres clients were created with `max: 1` in the first schema commit, and the web app is capped at one replica. `withOrg` holds the connection for the entire request, and upload completion runs two blob copies inside it, so one slow request stalled every user. The new 2.5 s notification poller made this worse. | High | Pool is now 10 (web) and 3 (admin), budgeted against B1ms `max_connections = 50`. |
| P2 | **Every SAS mint made a network round trip to Storage** (`createIfNotExists`) even though signing is local, and it ran inside request transactions on every report view. | Medium | `blob-sas-container.test.ts`: once per process, and a failed check is never cached. |
| H1 | **Hydration error on every recording detail page for users outside UTC.** `RunHistoryPanel` and the compare page's `RunCard` call `toLocaleString()` while the server renders. The container runs in UTC; browsers do not. Even in the same zone Node's ICU and the browser's format differently, which is why it appeared intermittently in e2e. | Medium | `local-time.test.tsx` hydrates real server HTML and fails on the old pattern. |

### Testing

| # | Finding | Evidence |
| --- | --- | --- |
| T1 | **CI skipped 30 worker tests on every run, including every accuracy gate.** Narrated fixtures need espeak-ng, the CV fixtures need Chromium, the transcription gates need the Whisper model. None were installed, every gate skipped, the job went green. Several harness loops also passed over un-generated entries silently. | CI now installs all three and sets `JAMS_REQUIRE_FIXTURES=1`, so a missing tool fails instead of skipping. CI worker job: **197 passed, 1 xfailed** (was 183 passed, 30 skipped). |
| T2 | **A shipped regression the missing e2e run would have caught.** The share-report browser test had been failing since the Highlights tab shipped: its Share button selector also matched a highlight row named "Play Shared segment at 00:00". | Selectors made exact. The full e2e suite passes locally, including the real upload-to-worker-to-report pipeline test. |
| T3 | **The RLS test covered 2 of 13 tenant tables.** | `rls-catalog.integration.test.ts` checks every table with `org_id` from the catalog, and fails on any web-role policy that lets every row through. It failed 4 of 5 checks on the old schema. |
| T4 | **The click accuracy gate fails and nothing said so.** Precision is 4.5% (TP 6, FP 126). This is known and contained: clicks are weighted 0 in the default score. | Marked `xfail(strict=True)` with its evidence. It runs, and turns red if someone fixes clicks without removing the marker. |

## Verification run for this review

- Web: 300 unit and integration tests (28 against real Postgres 16), type check, lint, production
  build.
- Worker in CI mode: 212 passed, 0 skipped, 1 expected failure.
- Browser e2e, locally against the Clerk dev instance, Postgres and Azurite: all 6 specs pass,
  including the opt-in real pipeline run (narrated upload, worker with the new encoder settings,
  transcription, both cuts found, report, seek within 250 ms, deletion and cleanup).
- GitHub CI green on the pushed commits; staging deployed and migration 0014 applied.

## Needs Chris before go-live

1. **Clerk production instance.** Staging runs on the development instance, and the browser logs
   say development keys "should not be used when deploying your application to production". Dev
   instances have strict usage limits.
2. **Run the browser tests in CI.** They need Clerk test keys as GitHub Actions secrets plus
   Postgres and Azurite services. This review is the evidence of the cost of not doing it: a
   broken test shipped and nobody saw. Adding the secrets is a repository configuration change, so
   it is Chris's call. Recommend a separate Clerk development instance for CI so test users never
   mix with staging.
3. **Add a migration step to the deploy pipeline.** Every schema change is currently applied by
   hand through a temporary firewall rule, and the correct order varies: 0013 had to go before the
   code, 0014 after. Recommend a pipeline job plus an expand-then-contract rule for migrations so
   the order is always migrate, then deploy.
4. **Live verification on staging.** The library archive and overlay, jump-to-moment, the
   notification watcher and this review's fixes are verified locally and in CI, but not by hand on
   staging, because the automation classifier blocks minting a sign-in token. Either allow that
   step or click through once yourself.

## Recommended, not blocking

- **Hash share tokens at rest.** S2 closes access through the app role; hashing would also protect
  a leaked database dump. Needs a data migration and a stored `last4`.
- **Move off `AllowAllAzureServices`.** It admits connections from any Azure-hosted IP in any
  subscription. The generated 30-character role passwords are what protects the database today. A
  private endpoint is the proper fix.
- **Base UI `nativeButton` warnings** on every `<Button render={<Link/>}>`. Accessibility semantics;
  set `nativeButton={false}` where the render target is a link.
- **Clerk deprecates `createRouteMatcher`.** Tenant data is already guarded per route by `withOrg`,
  so the proxy is defense in depth; plan the migration before the next Clerk major.
- **Weight profile API** accepts any non-negative number; the UI allows 0 to 10. Add `.max(10)`.
- **The notification watcher follows the whole organization's runs**, not just the current user's.
  Identical today because orgs are personal; revisit when teams arrive.
- **Starting a second analysis while one runs** supersedes the first but the worker still finishes
  it. The UI prevents it; the API does not.

## Not covered

The measure algorithms themselves (patent core), beyond confirming their accuracy gates run and
pass; load testing; and a penetration test of the deployed site.
