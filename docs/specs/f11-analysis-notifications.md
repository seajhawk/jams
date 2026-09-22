# Spec F11: tell people when their analysis is done

Why: a 6 minute 4K recording currently takes about 12 minutes to analyze (see
`docs/PIPELINE-PERF-2026-09-19.md`). Speed work will cut that, but a long journey will still take
minutes, and people will leave the tab. Today the only signal is the overlay on the library card and
its toast, and both vanish when the user navigates away or closes the tab.

Two independent layers. Build the first now; the second needs one decision and one small Azure
resource.

## Layer 1: in-app, no new infrastructure -- BUILT September 22, 2026

Shipped as `components/app/AnalysisWatcher.tsx`, `lib/analysis-watch.ts` and
`GET /api/analyses?active=1`, mounted once in the signed-in layout. Covered by
`__tests__/analysis-watcher.test.tsx` and `__tests__/analyses-active-api.test.ts`.
Item 3 landed as a tab-title badge only; no favicon badge.

### As specified

Goal: wherever the user is in JAMS, and even while the tab is in the background, they find out.

1. **App-wide watcher.** A client component in the signed-in layout that follows every active run
   for the current user, not just the ones on the library page. Source: a small
   `GET /api/analyses?active=1` (org-scoped via `withOrg`, returns id, video title, status,
   progress) polled with the same 2.5 s cadence and outage handling as `useAnalysisProgress`;
   idle (no active runs) polls at a slow 30 s or stops until an Analyze click wakes it.
2. **Completion toast anywhere**, with a "View report" action (the library toast today, made global).
3. **Tab title and favicon badge**: `(1) Analysis ready - JAMS` until the tab regains focus.
4. **Browser notification** (Notification API): request permission from the Analyze click (a user
   gesture, and the moment the reason is obvious), never on page load. Fire only if the tab is
   hidden. Failed runs notify too, with the same plain-language copy as the overlay.
5. Tests: watcher starts/stops with active runs, fires once per run, no notification when the tab
   is visible or permission denied, and survives a poll outage.

Limits: nothing arrives if every JAMS tab is closed. That is layer 2.

## Layer 2: email when it is done

Decided September 22, 2026: **Azure Communication Services**, per
`docs/CLOUDFLARE-EVALUATION-2026-09-22.md`. Cloudflare Email Service is cheaper but its native
binding is Workers-only, and our sender is Python in Azure. Not yet built.

Recipient is the user who requested the analysis, on their primary Clerk email. Sent once per run on
the terminal transition (succeeded, partial, failed), opt-out by a single link.

Decision needed from Chris: **send from the worker (instant) or from the web app (needs a web
hop).** Recommendation: the worker, with the recipient snapshotted at request time.

- `analysis_runs.notify_email text null` set by `POST /api/analyses` from the Clerk user (null when
  the user has opted out). The worker has no Clerk access, and this avoids giving it any.
- `run_notifications` outbox (run_id unique, channel, status, attempted_at, sent_at, error) so a
  send is idempotent and a worker retry never double-emails. Insert-then-send-then-mark.
- Sender: **Azure Communication Services Email** with the free Azure-managed domain
  (`*.azurecomm.net`), so there is no DNS or domain verification to block on. Provisioned in
  `infra/resources.bicep`; cost is fractions of a cent per email. Worker uses
  `azure-communication-email` with the connection string as a secret, like storage.
- Content: video title, status, effort score if scored, deep link to `/reports/{id}` (sign-in
  still required; no report data in the email body). Failure emails say what to do next.
- Delivery failures never fail the analysis: log `notification_failed` and move on.
- Preferences: `GET/PATCH /api/me/notification-settings` (email on/off, default on), and the
  one-click unsubscribe link signs the user id and flips the same flag without a login.
- Privacy: the email address lives on the run row only for the notification window; clear it once
  the notification is sent or the run is deleted (deletion lifecycle already sweeps the run).

Later, if wanted: a "notify me when this finishes" checkbox at Analyze time instead of a global
default, Slack/webhook channel for teams, and a weekly digest. None are needed for the first
preview.

## Out of scope here

Push to mobile, SMS, and notifying other members of the org.
