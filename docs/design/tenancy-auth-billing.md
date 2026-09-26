# DESIGN: Customers, sign-in, free tier and paid plans

September 26, 2026. Status: **proposed, for Chris's decision.** No code, accounts or migrations
were created for this document. Scope: multi-customer tenancy, authentication choice, free-tier
quotas, paid plans on Stripe, enforcement, rollout. Companion to `docs/PLAN.md` (architecture,
which already chose Clerk organizations and "Stripe direct, org = customer"),
`docs/PREVIEW-READINESS.md` (today's invite-only gate and preview limits) and
`docs/design/customer-journeys-ux.md` (the planned API/MCP that needs workspace tokens).

Prices below were read on September 26, 2026 unless marked otherwise. Prices change; recheck
before committing to a number. Anything marked **(unverified)** is my best reading, not a fact I
could confirm from a primary source.

**Assumption about the request.** Chris wrote "x per your". I read it as **x per hour**, because
he describes automation running around the clock. The design makes the window a configuration
value (`windowSeconds`), so "per hour", "per day" or anything else is a setting, not a code change.

---

## 1. Summary and recommendations

1. **Customer = organization. Keep it.** The repo already stamps `org_id` (a Clerk org id) on
   every tenant row, enforces it through `withOrg()` and Postgres RLS, and gives every user a
   hidden personal org. Multi-user customers are "just" Clerk organizations with more than one
   member. What is missing is the product around it: an org switcher, invitations, roles checked
   on sensitive routes, a membership mirror, and per-org plans.
2. **Auth: stay on Clerk. Do not switch to Entra External ID now.** At our scale Clerk costs $0
   (Hobby) to $25/month (Pro), and it already provides organizations, invitations, member
   management UI and a path to enterprise SSO. Entra External ID is also free up to 50,000 MAU,
   but it has no customer-organization model, admin-only invitations, no first-party Next.js
   App Router SDK, and a custom sign-in domain needs Azure Front Door ($35/month base). Switching
   would cost 2 to 4 weeks of building features Clerk already gives us, to save $0 to $25/month.
   Upgrade Clerk Hobby to Pro ($25/month) when the first customer pays (MFA, passkeys, no Clerk
   branding, one enterprise SSO connection). Buy the $100/month B2B add-on only when a customer
   needs more than 20 members, custom roles or verified-domain auto-join.
3. **Quotas are per customer org**, counted in **evaluation units** in a rolling window.
   One unit = one analysis of up to 5 minutes of recording; longer recordings use one unit per
   started 5 minutes. On free plans a second, per-user cap stops people multiplying the free
   quota by creating workspaces.
4. **Starter plans** (to validate with customers, not market-tested):

   | Plan | Price | Evaluation units | Max recording | Upload cap | Concurrent runs |
   |---|---:|---|---|---|---:|
   | Free | $0 | 1 per rolling 24 h | 5 min | 500 MB | 1 |
   | Pro | $79/mo | 24 per rolling 24 h (about 1 per hour, around the clock) | 20 min | 2 GiB | 2 |
   | Team | $249/mo | 72 per rolling 24 h (about 3 per hour) | 20 min | 2 GiB | 4 |

   Both paid prices clear the **worst-case** cost of a customer using every unit around the clock
   (Pro floor $70, Team floor $210; section 4). At expected costs the gross margin is about 70%.
   These floors rest on one real staging measurement; **re-run the benchmark on 1, 5 and 15
   minute narrated recordings before publishing prices** (section 4.2).
5. **Billing: Stripe direct, flat monthly subscriptions with hard quotas, no metered overage in
   v1.** Hosted Checkout to subscribe, hosted Customer Portal to manage, a signed webhook that
   reuses the `webhook_events` ledger, and entitlements stored in our database and derived by
   re-fetching the subscription from Stripe on every event (order-independent). Do not use Clerk
   Billing: it has no tax support, no refunds and USD only.
6. **Enforcement stays in Postgres**, inside the same transaction that creates the work, under
   the per-org advisory lock the preview limits already use. A new append-only `usage_events`
   ledger replaces "count the runs" and survives recording deletion.
7. **Rollout in seven small phases** (section 7). The invite-only `JAMS_PREVIEW_USER_IDS` gate
   keeps working until the very last step; plan-based quotas ship behind it first, then sign-up
   opens with a global daily budget for free usage as a hard cost ceiling.

**What Chris must do by hand**: pick and buy the domain (it also unblocks the Clerk production
instance), create the Stripe account and complete the checklist in section 5.9, decide the
open questions in section 8.

---

## 2. Tenancy model

### 2.1 What exists today (read from the repo)

| Piece | Where | State |
|---|---|---|
| `orgs` table: `id` (Clerk org id), `name`, `is_personal`, `plan` (enum with only `free`), `stripe_customer_id` | `apps/web/src/db/schema.ts` | Plan and Stripe columns exist but are unused. |
| `users` table: Clerk user id, email, display name | same | Global mirror, not tenant-owned; web role has no grant (0007). |
| Memberships | none | Read live from the Clerk session; not mirrored. |
| Tenant chokepoint | `apps/web/src/lib/with-org.ts` | Resolves `userId` and active `orgId` from the Clerk session, never from input; falls back to the personal org; sets `app.org_id` for RLS per transaction. Does not expose the member's role. |
| Hidden personal org | `apps/web/src/lib/clerk/personal-org.ts` | A real Clerk org per user, `privateMetadata.personal = true`, `maxAllowedMemberships: 1`, stable slug, lock-protected creation. |
| Webhook mirror | `apps/web/src/lib/clerk/webhook.ts`, `app/api/webhooks/clerk/route.ts` | svix-verified, idempotent via `webhook_events` (source `clerk` or `stripe`), mirrors users and orgs; membership events only touch the org row. |
| RLS | `apps/web/src/db/migrations/0007_postgres_rls.sql`, `0014` | `jams_web` (no BYPASSRLS) sees rows where `org_id = current_setting('app.org_id')`; `jams_worker` bypasses RLS and is also used by the web tier's admin client for webhooks and dispatch. `rls-catalog.integration.test.ts` fails on any table with `org_id` lacking a policy. |
| Invite-only preview | `apps/web/src/proxy.ts`, `lib/preview-access.ts` | Exact Clerk user-id allowlist at the request boundary and again in `resolveOrgContext`. |
| Preview quotas | `lib/preview-limits.ts` | Per org, only when the allowlist is set: lifetime analyses (default 100), active runs (2), declared storage (10 GiB); serialized by `pg_advisory_xact_lock`. |
| UI | `components/app/AppShell.tsx` | `UserButton` only. No org switcher, no members page. |

### 2.2 Target model

```
Customer organization (Clerk org, row in orgs)           billing entity, quota owner
 ├── members (Clerk memberships, mirrored in org_memberships)
 │     role: admin | member      "owner" = the admin recorded in orgs.created_by
 ├── plan + limits  (org_entitlements, written only by billing/admin code)
 ├── usage ledger   (usage_events, append-only)
 ├── API tokens     (api_tokens, hashed, org-scoped; for the planned API/MCP)
 └── projects > goals > journeys > sessions > analyses   (unchanged)
```

- **Personal workspace.** Every user keeps a personal org. It is shown in the switcher as
  "My workspace" (today it is hidden only because there is no switcher). It stays single-member
  (`maxAllowedMemberships: 1`, already set). Free users live here.
- **Team workspace.** A normal Clerk org with two or more members. Created from the switcher
  ("Create team workspace") or by **converting** the personal workspace when upgrading, so
  recordings do not have to move: raise `maxAllowedMemberships`, clear `privateMetadata.personal`,
  set `orgs.is_personal = false`. `ensurePersonalOrganization` then lazily creates a fresh
  personal org the next time the user has no active org. Moving recordings between orgs is not
  offered (blob paths are org-prefixed; a move is a copy plus a delete).
- **Roles.** Use Clerk's two built-in roles, `org:admin` and `org:member`. Custom roles need
  Clerk's B2B add-on ($100/month), so "owner" is not a Clerk role in v1: it is the admin recorded
  in `orgs.created_by`, used as the default billing contact and protected from removal in our UI.
  Capabilities:

  | Action | member | admin |
  |---|:-:|:-:|
  | Upload, analyze, view, compare, share, export | yes | yes |
  | Delete or archive a recording they uploaded | yes | yes |
  | Delete anyone's recording, edit weight profiles | no | yes |
  | Invite/remove members, change roles | no | yes |
  | Billing (checkout, portal), plan changes | no | yes |
  | Create/revoke API tokens | no | yes |

- **Invitations.** Clerk organization invitations and its `<OrganizationProfile>` members screen
  (email invite, accept, role change, removal). No invitation table of our own. Seat limits are
  enforced by Clerk: when the plan changes, the billing webhook sets the org's
  `maxAllowedMemberships` to the plan's member cap.
- **Membership mirror.** Add `org_memberships (org_id, user_id, role, created_at, updated_at)`,
  written by the existing Clerk webhook on `organizationMembership.created/updated/deleted`.
  Authorization at request time still comes from the session (fresh, signed); the mirror is for
  counting seats, per-user quota checks, notification scoping, the admin page, and portability if
  we ever leave Clerk.
- **Org context.** `withOrg()` gains `orgRole` (from `auth().orgRole`) and a helper
  `requireOrgAdmin(ctx)`. A second resolver path accepts an API token instead of a session
  (section 6.5), producing the same `OrgContext`.

### 2.3 Schema changes (all additive, one-push safe per the runbook)

| Change | RLS / grants |
|---|---|
| `orgs.created_by text` | existing policy |
| `org_memberships` | `jams_web`: SELECT own org only. Writes via admin client (webhook). |
| `org_entitlements (org_id PK, plan_id text, source 'default'/'stripe'/'manual', status, current_period_end, grace_until, manual_until, limits_override jsonb, suspended_at, updated_at)` | `jams_web`: **SELECT only**, own org. Writes only via admin client. A tenant route bug can never raise its own plan. |
| `billing_subscriptions (stripe_subscription_id PK, org_id, stripe_customer_id, status, price_lookup_key, plan_id, current_period_start/end, cancel_at_period_end, canceled_at, raw jsonb, synced_at)` | `jams_web`: SELECT own org (for the billing page). Writes via admin client. |
| `usage_events (id, org_id, user_id, kind, units, run_id, video_id, plan_id, idempotency_key, occurred_at, refunded_at, refund_reason)` with index `(org_id, occurred_at)` and unique `(org_id, idempotency_key)` | `jams_web`: SELECT + INSERT own org; no UPDATE/DELETE. Refunds written by worker/watchdog (bypass role). Not cascaded from videos or runs. |
| `api_tokens (id, org_id, name, token_hash, prefix, role, created_by, last_used_at, revoked_at, created_at)` | Own-org SELECT/INSERT/UPDATE(revoked_at). Lookup by hash uses the `app.share_token` pattern from 0014: a policy that reveals only the row whose hash the caller presents. |
| `analysis_runs.max_duration_ms integer` (nullable) | existing policy. Worker treats null as today's 20-minute cap. |
| `orgs.plan` enum | Leave in place, stop reading it; drop in a later two-push change. |

`orgs.stripe_customer_id` already exists; add a unique index. The `rls-catalog` test will force a
policy on each new `org_id` table, which is the intended guard.

---

## 3. Authentication: comparison and recommendation

### 3.1 How much of the repo is Clerk

- **11 source files** import `@clerk/*`: `app/layout.tsx` (`ClerkProvider`), `app/sign-in`,
  `app/sign-up`, `app/share/[token]/page.tsx`, `components/app/ActiveOrgSync.tsx`,
  `components/app/AppShell.tsx`, `lib/admin-auth.ts`, `lib/with-org.ts`, `proxy.ts`
  (`clerkMiddleware`, `createRouteMatcher`), `lib/clerk/personal-org.ts`, `lib/clerk/webhook.ts`.
- `lib/clerk/` is 780 lines (mirror store, personal-org provisioning, webhook application,
  types) plus `app/api/webhooks/clerk/route.ts`.
- **7 test files**: 5 unit/integration tests and 2 Playwright files (`@clerk/testing`).
- Infra: 3 Clerk secrets/settings in `infra/resources.bicep`; `svix` dependency.
- **Data**: Clerk ids are the primary keys of `orgs` and `users`, the `org_id` of about 17
  tenant tables, and the first segment of every blob path (`videos/{org_id}/...`). They are
  opaque text, so a future provider switch can keep them as internal ids and map the new
  provider's ids to them; nothing has to be rewritten, but every lookup goes through a mapping.

Estimated effort to replace Clerk: 1 to 2 weeks for a provider with an org model (WorkOS,
Stytch), 2 to 4 weeks for one without (Entra External ID, Better Auth), because organizations,
invitations, member UI and the personal-org flow must be rebuilt. **(estimate)**

### 3.2 Comparison

Costs are monthly cash, for the auth vendor only. "Orgs" means customer organizations with two or
more members. Clerk counts only retained users (active on a day after sign-up) and only orgs with
at least two members, so personal workspaces are never billed as organizations.

| | **Clerk** (incumbent) | **Entra External ID** | **Auth0** (Okta) | **WorkOS AuthKit** | **Stytch B2B** | **Better Auth** (self-hosted OSS) |
|---|---|---|---|---|---|---|
| 100 MAU, 10 orgs | $0 Hobby; $25 Pro if MFA wanted | $0 | Free plan allows 5 orgs, so B2B Essentials: **$150** | $0 | $0 | $0 license |
| 1,000 MAU, 100 orgs | $0 Hobby (100 orgs is the included limit); $25 Pro | $0 | about **$300** (Essentials) | $0 | $0 | $0 |
| 10,000 MAU, 100 orgs | $25 Pro (free up to 50,000 retained users) | $0 (free up to 50,000 MAU; $0.03/MAU above) | about **$2,100** (Essentials) | $0 (free to 1M MAU) | $0 at 10,000 (free-tier edge; above is not published) | $0 |
| More than 100 orgs, >20 members/org, custom roles | B2B add-on **$100/mo**, then $1/org/mo past 100 | Build it ourselves | Plan-dependent | Included | Included ("unlimited organizations") | Included (organization plugin) |
| Customer org model with many users | Yes: orgs, roles, invitations, member UI components, org switcher | **No.** Single directory; groups and app roles only; invitations are for admins only | Yes (Organizations) | Yes: orgs, memberships, roles, invitations | Yes (B2B is org-first) | Yes: organization plugin with owner/admin/member, invitations, teams |
| Enterprise SSO | Pro includes 1 connection; then $75/mo each (2 to 15) | SAML/WS-Fed and OIDC federation; no per-connection fee found **(unverified)** | Essentials includes 3; about $100/mo each after | $125/mo per connection | 5 free, then $125 each | SSO plugin (SAML, OIDC), $0 |
| SCIM | Included with an enterprise connection per Clerk's pricing article **(unverified on the pricing page)** | No inbound SCIM from customer IdPs found | Higher tiers | $125/mo per directory | Counts against the same 5 free, then $125 | Not verified |
| MFA | Pro and up (not on Hobby) | Email OTP, passkeys; SMS billed per message | Paid factors on paid plans | Included | Included | Plugin (we operate it) |
| Next.js App Router fit | First-party SDK, already integrated | No first-party Next.js SDK; Microsoft samples are Node/Express; use Auth.js or openid-client | First-party SDK | First-party `authkit-nextjs` | SDK available | First-party, runs in our app and Postgres |
| Custom domain | Production instance **requires a domain we own**; social login needs our own OAuth apps | Custom URL domain requires **Azure Front Door** ($35/mo base + usage); otherwise `<tenant>.ciamlogin.com` | 1 custom domain on Free | $99/mo (optional) | $99 one-time | Our domain, no cost |
| Azure fit | Neutral (SaaS) | Best: Azure-billed, Microsoft accounts and Entra federation native | Neutral | Neutral | Neutral | Runs inside our ACA app and Postgres |
| Lock-in | Medium: user export includes password hashes | High on UX (hosted flows), low on identity (standard OIDC) | Medium | Medium | Medium | Lowest: data in our DB |
| Security posture | Managed; bot protection, disposable-email and subaddress blocking, org-creation limits; SOC 2 | Microsoft-managed, Conditional Access (limited in external tenants), smart lockout, 7-day log retention | Mature, managed | Managed, strong enterprise focus | Managed | **We own it**: sessions, CSRF, email verification, lockout, bot defense, patching |
| Migration from Clerk | none | 2 to 4 weeks (org, invite, member UI, personal org rebuilt) | 1 to 2 weeks | 1 to 2 weeks | 1 to 2 weeks | 2 to 4 weeks |

Supabase Auth was not researched in depth: it has no organization model and would add a second
platform next to our own Postgres, so it is not a fit.

### 3.3 Entra External ID, specifically

Chris asked to consider Entra. It is a credible identity service and the cheapest on paper, but
for this product the cost is engineering, not cash:

- **No customer organizations.** An external tenant is one directory. "Customer X with 5 users"
  would be our own tables, our own invitation emails and acceptance flow, our own member
  management UI and role storage. Microsoft's feature table says invitations in external tenants
  are for administrative purposes only and cannot be used to invite customers to apps.
- **No first-party Next.js App Router SDK.** Workable through Auth.js or `openid-client`, but we
  would own token refresh, session cookies and middleware integration that Clerk provides.
- **Custom sign-in domain needs Azure Front Door**, $35/month base plus request and transfer
  charges. Without it, sign-in happens on `<tenant>.ciamlogin.com`.
- **What it does well**: free to 50,000 MAU, billed to Azure (credits may apply
  **(unverified)**), Microsoft-account and Entra-ID federation are native (attractive for
  customers who live in Microsoft 365), SAML/OIDC federation, passkeys, email OTP.

When Entra would be the right call: if a large customer requires identities to live in a
Microsoft tenant we control, or if we ever exceed 50,000 retained users and Clerk's per-user
price starts to matter. Neither is near.

### 3.4 Recommendation

**Stay on Clerk.** Reasons, in order:

1. It already does the hard part of "one customer, many users" (orgs, invitations, roles, member
   UI, org switcher) and the repo is built around it, including the tested personal-org flow and
   webhook ledger.
2. Cash cost fits "don't spend now": $0 during the invite-only preview, $25/month from the first
   paying customer, $100/month more only when a customer outgrows 20 members or needs custom roles.
3. Enterprise path is cheap: one SAML/OIDC connection included in Pro, $75/month after.
4. Switching now is the cheapest it will ever be (few users), but it still buys nothing we need:
   every alternative is either the same price with less built in (Entra, Better Auth) or similar
   capability at a similar or higher price (WorkOS, Stytch, Auth0).

Hedge against lock-in without paying for it now: mirror memberships into Postgres (section 2.2),
keep all Clerk calls behind `lib/clerk/` and `with-org.ts`, and use our own hashed API tokens
rather than Clerk API keys. **Runner-up if we ever switch: WorkOS AuthKit** (free to 1M MAU, orgs
included, strongest enterprise SSO/SCIM story), at the cost of $125 per SSO connection.

Clerk settings to turn on at open sign-up: bot protection on sign-up, block disposable email
domains, block email subaddresses, require verified email, limit organizations a user can create
(default is 100; set to 2), Google and Microsoft social login with our own OAuth apps. Which of
these are on Hobby versus Pro was not confirmed **(unverified)**; check in the dashboard.

---

## 4. Plans, quotas and pricing

### 4.1 Unit and window design

- **Quota owner: the customer org, not the user.** The org is who pays, and cost scales with
  evaluations, not people. Per-user quotas would reward inviting extra accounts, and a team
  sharing one allowance is what customers expect.
- **Free-tier anti-multiplication:** in addition to the per-org limit, a user may start at most
  **1 free-plan unit per rolling 24 hours across all free orgs they belong to.** Creating a second
  free workspace, or being invited into five, does not add free capacity. Paid orgs are not
  subject to this per-user cap.
- **Evaluation unit.** One unit covers up to **5 minutes** of recording. A recording uses
  `ceil(duration / 5 min)` units (a 12-minute session uses 3). This keeps the cost of one unit
  bounded no matter how long recordings are, so "N per hour" has a worst-case cost we can price.
  The free plan's 5-minute cap means a free evaluation is always exactly one unit, which matches
  "1 eval per day" literally.
- **Rolling window, configurable.** Each plan has `{ units, windowSeconds }`. Recommended values
  use a 24-hour window (Pro: 24 per 24 h) rather than 1 per hour, for two reasons: a 20-minute
  recording needs 4 units, which a 1-per-hour window could never admit, and people upload in
  bursts. Sustained worst case is identical (about 730 units a month). Chris can set
  `windowSeconds: 3600, units: 1` if he wants literal hourly.
- **Rolling, not calendar.** "Next evaluation available at 3:14 PM" avoids time-zone confusion
  and midnight double-bursts.

### 4.2 Cost model

**Azure Container Apps consumption rates (East US 2, the staging region), from the Azure Retail
Prices API:** active vCPU $0.000024 per second, memory $0.000003 per GiB-second, requests $0.40
per million. Jobs are billed at the active rate for the whole execution. Monthly free grant per
subscription: 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests.

- Worker at **4 vCPU / 8 GiB** (what `infra/resources.bicep` deploys since September 19):
  $0.000120 per second, **$0.432 per hour**.
- Worker at **2 vCPU / 4 GiB** (the size in the brief and in PLAN.md): $0.000060 per second,
  $0.216 per hour.

Note the discrepancy: the brief says 2 vCPU / 4 GiB, the deployed job is 4 vCPU / 8 GiB. When
work scales near-linearly with cores, cost per evaluation is about the same on either size; the
larger worker only finishes sooner. The model below is expressed per 4-vCPU second with a 25%
penalty for imperfect scaling.

**Throughput evidence** (`docs/PIPELINE-PERF-2026-09-19.md`): one real 6:03 silent 4K recording
took 755 s on 2 vCPU (2.08 s of processing per second of video), which cost about $0.045. Encoder
changes and 4 vCPU were then shipped with an expected 100 to 150 s for the same file, **not yet
re-measured**. Transcription (narrated recordings) was not in that run; local distil-small.en
ran at 0.14x real time on Chris's machine (`docs/benchmarks/whisper-local.md`), not on ACA.

Two scenarios:

- **Ceiling** (use this for price floors): 2.6 s of 2-vCPU processing per second of video (the
  measured 2.08 plus 0.5 for transcription), times 1.25 scaling penalty, plus 120 s fixed
  overhead (start, model load, download) at 4 vCPU. Storage and egress: 2.5 Mbit/s recordings,
  original plus normalized copy kept 90 days in Hot LRS ($0.0184/GB-month), one full playback
  egressed at $0.087/GB.
- **Expected** (post-optimization target): 0.5 s of 4-vCPU processing per second of video plus
  60 s fixed; 1.5 Mbit/s, half a playback, 30 days storage.

| Recording length | Ceiling wall time (4 vCPU) | Ceiling cost | Expected wall time | Expected cost |
|---|---:|---:|---:|---:|
| 1 min | 218 s | **$0.030** | 90 s | **$0.012** |
| 5 min (one unit) | 608 s | **$0.091** | 210 s | **$0.030** |
| 15 min | 1,582 s | **$0.245** | 510 s | **$0.075** |
| 20 min (cap) | 2,070 s | $0.322 | 660 s | $0.097 |

Absolute backstop per run: the job's `replicaTimeout: 3600` bounds one execution at $0.43, and
queue redelivery allows at most 4 executions before the poison queue, so no single run can cost
more than about $1.75 whatever the input.

The free grant covers about 45,000 s of the 4-vCPU worker a month, roughly 200 expected-case
5-minute evaluations, if nothing else consumes it.

**Fixed platform costs** (not per evaluation, covered by Azure credits per PLAN.md): Postgres B1ms
compute $0.017/hour (about $12.40/month) plus storage; pinned web replica about $10 to $15/month;
Clerk $0 to $25; domain. Per-evaluation margins below do not include these.

### 4.3 Price floor for "N per hour around the clock"

A month has about 730 hours, so a plan that sustains N units per hour can consume at most
`730 x N` units. Stripe takes 2.9% + $0.30 per charge, Billing 0.7% of billing volume, and
Stripe Tax 0.5% where registered (4.1% plus $0.30 total).

```
price_floor = (730 x N x ceiling_cost_per_unit) / (1 - 0.041) + $0.30
ceiling_cost_per_unit = $0.0914     expected_cost_per_unit = $0.0297
```

| N units per hour | Max units / month | Ceiling cost | **Price floor** | Expected cost | Price for 70% expected margin |
|---:|---:|---:|---:|---:|---:|
| 1 | 730 | $66.72 | **$69.87** | $21.68 | $75.4 |
| 2 | 1,460 | $133.44 | **$139.45** | $43.36 | $150.7 |
| 3 | 2,190 | $200.17 | **$209.02** | $65.04 | $226.1 |
| 4 | 2,920 | $266.89 | **$278.60** | $86.72 | $301.4 |

**Recommended starter numbers**

| | Free | Pro | Team |
|---|---|---|---|
| Price | $0 | **$79/month** | **$249/month** |
| Units | 1 per 24 h | 24 per 24 h (1/hour sustained) | 72 per 24 h (3/hour sustained) |
| Worst-case monthly cost | $2.74 per org (30 units) | $66.72 | $200.17 |
| Margin if maxed out, ceiling costs | n/a | $8.8 (11%) | $38.3 (15%) |
| Margin if maxed out, expected costs | n/a | $53.8 (68%) | $173.4 (70%) |
| Max recording | 5 min | 20 min | 20 min |
| Max upload | 500 MB | 2 GiB | 2 GiB |
| Concurrent runs | 1 | 2 | 4 |
| Storage cap | 2 GiB | 50 GiB | 250 GiB |
| Recording retention | 30 days | 180 days | 365 days |
| Members | 1 (personal) or up to 3 (team) | 5 | 20 (Clerk's no-add-on limit) |
| API tokens | no | yes | yes |

A typical customer will not run around the clock, so real margins will be far higher; the point
of the floor is that **no customer can make a plan lose money**, even with automation. If the
benchmark shows the optimized pipeline is near the expected case, prices can drop or units rise.
PILOT-RELEASE.md says not to invent willingness to pay; treat these as cost-safe starting points
to test in pilot conversations.

**Global free budget.** A server setting `JAMS_FREE_DAILY_UNITS` (start at 50) caps free units
across all customers per rolling 24 h. At the ceiling that bounds free-tier compute at about
$137/month no matter how many accounts sign up. When it is exhausted, free users see "Free
capacity is full today; try again after 3:14 PM or upgrade" and paid users are unaffected.

**Capacity.** The worker job allows `maxExecutions: 3` across all customers. One Team customer at
ceiling speed needs 0.5 of a slot on average and up to 4 at once. Raise `maxExecutions` to 10
before the first paid plan and check the environment's consumption-core quota (10 executions x
4 vCPU = 40 cores; the default quota was not confirmed **(unverified)**; `az containerapp env
list-usages` shows it).

### 4.4 Why flat plans with hard quotas, not metered billing

- Predictable for the customer and for Chris; no surprise invoices while trust is being built.
- No usage-reporting pipeline to Stripe. Stripe's legacy usage records were removed in API
  version 2025-03-31.basil; metered prices now require Billing Meters and reliable meter-event
  reporting, which is a real integration with its own failure modes.
- Hard caps are the cost control. Metered overage removes the cap, which is exactly the risk the
  preview cannot afford.
- Later, if customers hit caps: sell a one-time "extra 100 units" pack (a Checkout payment, same
  ledger) before introducing metered overage on Meters.

---

## 5. Stripe integration

### 5.1 Objects in Stripe

- **Products**: "JAMS Pro", "JAMS Team". Free has no Stripe object.
- **Prices**: monthly, USD, recurring, tax behavior exclusive, with **lookup keys**
  `jams_pro_monthly_v1`, `jams_team_monthly_v1`. Code refers to lookup keys, never price ids. A
  price change creates `_v2`; existing subscribers stay on `_v1` until migrated deliberately.
- **Customer**: one per org, created lazily at first checkout with `metadata.org_id` and
  idempotency key `jams-customer-{orgId}`; id stored in `orgs.stripe_customer_id` (unique).
- **Subscription**: at most one non-canceled subscription per org; `metadata.org_id` set through
  Checkout's `subscription_data.metadata`.
- Stripe's Entitlements feature is not used; plan limits live in code (`lib/plans.ts`) keyed by
  lookup key. One source of truth, testable without Stripe.

### 5.2 Data model (ours)

`billing_subscriptions` and `org_entitlements` from section 2.3, plus the existing
`webhook_events` ledger (`source = 'stripe'`, `external_id` = Stripe event id `evt_...`).

Plan catalog in code:

```ts
// apps/web/src/lib/plans.ts (proposed)
export const PLANS = {
  free: { units: 1,  windowSeconds: 86_400, unitSeconds: 300, maxRecordingSeconds: 300,
          maxUploadBytes: 500 * MB, maxActiveRuns: 1, maxStorageBytes: 2 * GiB,
          retentionDays: 30, maxMembers: 3, apiTokens: false, perUserFreeCap: true },
  pro:  { units: 24, windowSeconds: 86_400, unitSeconds: 300, maxRecordingSeconds: 1_200,
          maxUploadBytes: 2 * GiB, maxActiveRuns: 2, maxStorageBytes: 50 * GiB,
          retentionDays: 180, maxMembers: 5, apiTokens: true, stripeLookupKey: "jams_pro_monthly_v1" },
  team: { units: 72, /* ... */ maxActiveRuns: 4, maxStorageBytes: 250 * GiB, retentionDays: 365,
          maxMembers: 20, apiTokens: true, stripeLookupKey: "jams_team_monthly_v1" },
  preview: { /* today's JAMS_PREVIEW_* values, assigned manually to invited testers */ },
} as const
```

Effective limits = `PLANS[plan_id]` merged with `org_entitlements.limits_override` (for pilots
and custom deals). Precedence: unexpired manual entitlement, then Stripe, then free.

### 5.3 Flows

**Upgrade (admin only).** Settings > Plan > "Upgrade to Pro".

1. `POST /api/billing/checkout { plan: "pro" }` inside `withOrg`, `requireOrgAdmin`.
2. If the org already has a non-canceled subscription, return the Portal URL instead (no second
   subscription).
3. Under the org advisory lock: get or create the Stripe customer.
4. Create a Checkout Session: `mode: "subscription"`, price by lookup key, `customer`,
   `client_reference_id: orgId`, `subscription_data.metadata.org_id`,
   `automatic_tax.enabled` (if Stripe Tax is on), `customer_update.address: "auto"`,
   `billing_address_collection`, `consent_collection.terms_of_service: "required"`,
   `success_url: /settings/plan?checkout={CHECKOUT_SESSION_ID}`, `cancel_url`.
   Idempotency key `checkout-{orgId}-{plan}-{minute}` to absorb double clicks.
5. Browser goes to Stripe. On return, the page shows "Activating Pro..." and calls
   `POST /api/billing/sync { session_id }`, which retrieves the session server-side, checks that
   `client_reference_id` equals the caller's org, and runs the same sync as the webhook. The
   webhook remains the source of truth; this only removes the wait.

**Manage.** `POST /api/billing/portal` (admin) returns a Customer Portal session URL. Portal
configuration: update payment method, invoice history, switch between Pro and Team, cancel at
period end, downgrades scheduled at period end (`schedule_at_period_end`), no pause.

**Webhook.** `POST /api/webhooks/stripe` (already public in `proxy.ts` via `/api/webhooks(.*)`):

1. Read the raw body, verify `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`
   (`stripe.webhooks.constructEvent`). Reject on failure (400).
2. Reserve `event.id` in `webhook_events` exactly as `applyClerkWebhookEvent` does (completed:
   duplicate; in progress: 409 with Retry-After; failed: reclaim).
3. Resolve the subscription id from the event, **retrieve the current subscription from the
   Stripe API** and upsert it. Never apply the event payload as a delta. Stripe does not guarantee
   delivery order, so "fetch latest and overwrite" makes every event idempotent and
   order-independent.
4. Verify the org: `subscription.metadata.org_id` must equal the org whose
   `stripe_customer_id` is the subscription's customer. Mismatch: mark the event failed and alert;
   never guess.
5. Recompute `org_entitlements` for that org in the same transaction as the ledger completion
   (`commitEvent`).
6. After commit, set the Clerk org's `maxAllowedMemberships` to the plan's member cap
   (idempotent; a failure marks the event failed so Stripe retries).
7. Respond 2xx fast. Stripe retries failed deliveries for up to 3 days in live mode.

**Events to subscribe:** `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
`invoice.payment_failed`, `invoice.payment_action_required`, `charge.dispute.created`.
Add `customer.subscription.trial_will_end` only if trials are introduced. Everything else is
recorded as ignored.

### 5.4 Status to entitlement mapping

| Stripe subscription status | Entitlement |
|---|---|
| `active`, `trialing` | Plan from the price lookup key |
| `active` with `cancel_at_period_end` | Paid plan until period end; banner "Pro ends on Oct 31" |
| `past_due` | Paid plan during grace (`grace_until` = first failure + 14 days); banner and email from Stripe asking to update the card |
| `unpaid`, `canceled`, `incomplete_expired`, `paused` | Free |
| `incomplete` | Free (first payment not completed) |
| `charge.dispute.created` on any charge | Org `suspended_at` set, new work blocked, Chris alerted; data kept |

### 5.5 Upgrades, downgrades, cancellation

- **Upgrade** (Free to Pro, Pro to Team): immediate, prorated by Stripe. New limits apply on the
  next admission check after the webhook (or the success-page sync).
- **Downgrade** (Team to Pro): scheduled at period end by the Portal; limits change when Stripe
  switches the subscription.
- **Cancel**: at period end; then Free. Nothing is deleted at the moment of downgrade. If usage
  exceeds the new plan (storage, members), new uploads or invitations are blocked with a clear
  message until the customer is under the limit; recordings older than the new plan's retention
  enter the normal retention sweep after a 14-day notice period.
- **Org deleted in Clerk** (`organization.deleted`): cancel its Stripe subscription immediately,
  then run the existing tenant deletion path.

### 5.6 Failed payments

Stripe Smart Retries plus Stripe's own customer emails for failed payments and expiring cards.
Settings: retry for up to 14 days, then **cancel** the subscription (simpler than `unpaid`). Our
side only maps status (5.4) and shows a banner with a Portal link to admins.

### 5.7 Test mode for development

- Use a Stripe **sandbox** (Stripe's replacement for "test mode") for local, CI and staging;
  live keys only in production.
- Local: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
- Tests: unit tests on the status mapping and sync function with recorded fixtures; one
  integration test against real Postgres for the ledger path (as the Clerk webhook test does);
  a scripted sandbox rehearsal with **test clocks** covering renewal, failed renewal with Smart
  Retries, cancel at period end and upgrade proration. No Stripe calls in CI unit tests.

### 5.8 Tax

Recommendation: **yes to Stripe Tax, but collect only where registered.** Enable Stripe Tax
monitoring from day one so Stripe reports when sales approach a state's registration threshold.
Many US states tax SaaS (Washington, Texas and New York among them **(unverified; confirm with
an accountant)**). If Chris's business is registered in a state that taxes SaaS, turn on
`automatic_tax` in Checkout from the first sale (0.5% per transaction on the no-code
integration). Prices are shown tax-exclusive. Product tax code: SaaS, business use
(`txcd_10103001` **(unverified)**).

### 5.9 Checklist for Chris (manual, in this order)

1. Create the Stripe account (business type, legal name, EIN or SSN, bank account). Turn on
   two-factor authentication for the Stripe login.
2. Public website pages Stripe reviews at activation: pricing, terms of service, privacy policy,
   refund and cancellation policy, support contact **(Stripe's exact requirements unverified)**.
3. In a **sandbox**: create Products "JAMS Pro" and "JAMS Team", monthly USD prices $79 and $249
   (or the final numbers), tax behavior exclusive, lookup keys `jams_pro_monthly_v1` and
   `jams_team_monthly_v1`, tax code SaaS business use.
4. Customer Portal (Settings > Billing > Customer portal): allow payment-method update, invoice
   history, cancellation at period end, switching between the two prices, downgrades at period
   end; add terms and privacy links.
5. Billing > Revenue recovery: Smart Retries on, retry window about 14 days, then cancel the
   subscription; turn on failed-payment and expiring-card emails; turn on receipts.
6. Stripe Tax: head-office address, registrations (at least the home state if SaaS is taxable
   there), threshold monitoring on.
7. Branding: logo, colors, statement descriptor "JAMS", support email.
8. Webhook endpoint `https://<domain>/api/webhooks/stripe` with the events in 5.3; copy the
   signing secret.
9. A **restricted API key** with only: Customers write, Checkout Sessions write, Billing Portal
   sessions write, Subscriptions read, Prices read, Invoices read. Put it and the webhook secret
   in the Container App secrets as `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (never in git,
   never in chat). No publishable key is needed with hosted Checkout.
10. Run the test-clock rehearsal (5.7) on staging, then repeat steps 3 to 9 in live mode and swap
    the production secrets.

Prerequisite shared with Clerk production: **the domain**. Both the Clerk production instance
and the Stripe webhook URL need it.

---

## 6. Enforcement design

### 6.1 Where each limit is checked

| Limit | Checked at | File (proposed change) |
|---|---|---|
| Sign-up allowed | Clerk dashboard (bot protection, disposable email, verified email); access mode at the request boundary | Clerk settings; `apps/web/src/proxy.ts`, `lib/preview-access.ts` becomes `lib/access.ts` |
| Org suspended | Every tenant request | `lib/with-org.ts` `resolveOrgContext` reads `org_entitlements.suspended_at` |
| Admin-only actions | Billing, members, API tokens, delete others' recordings | `lib/with-org.ts` exposes `orgRole`; new `lib/authz.ts` `requireOrgAdmin` |
| Upload size (declared) | Create upload | `app/api/videos/route.ts` POST calls `assertUploadAdmission` (plan `maxUploadBytes`, returns 413) |
| Storage cap, concurrent uploads, uploads per day | Create upload | `lib/usage-limits.ts` (successor of `lib/preview-limits.ts`), same advisory lock |
| Upload size (actual) | Finalize | `lib/blob.ts` `finalizeBlob` already rejects a blob whose length differs from the declared size; `app/api/videos/[id]/complete/route.ts` |
| Duration (declared) | Finalize and create upload | `app/api/videos/[id]/complete/route.ts` rejects `duration_ms` over the plan cap; optional `duration_ms` on POST `/api/videos` for an early, friendly error |
| Units in window, active runs, per-user free cap, global free budget | Queue an analysis | `assertAnalysisAdmission` called by `lib/queue-analysis.ts` (U2 branch) or `app/api/analyses/route.ts` (main); inserts the `usage_events` row in the same transaction as the run |
| Bulk re-analysis | Per session queued | `app/api/journeys/[id]/reanalyze/route.ts` (U2 branch) already stops at the first limit error; UI states "uses N of your M remaining units" before confirming |
| Duration (authoritative) | Worker probe | `worker/src/jams_worker/providers/probe.py`: replace constant `MAX_DURATION_SECONDS` with `min(run.max_duration_ms, 20 min)`; the web stamps `max_duration_ms = units_charged x 5 min` (capped by plan) on the run |
| Refund of units | Run failure that is our fault | `worker/src/jams_worker/db.py` `finalize()` for `transient`/`unknown`; watchdog stale-run handling (`app/api/admin/watchdog`) |
| Duplicate run on the same video | Queue an analysis | Reject with 409 when the video has a queued/running run (today the API supersedes but the worker still runs both, per the pre-launch review) |
| API request rate | Token-authenticated requests | new `lib/api-tokens.ts` plus a Postgres fixed-window counter (section 6.5) |
| Retention | Scheduled | Watchdog sweep enqueues expired recordings into the existing `recording_deletions` lifecycle |
| Share-link playback | Share page and playback SAS | `app/share/[token]/page.tsx`, `app/api/videos/[id]/playback-sas`: per-token mint rate limit |

### 6.2 Race-free window in Postgres

All admission paths for an org take the same transaction-scoped advisory lock the preview limits
already use (`lockPreviewUsage`, renamed `lockOrgUsage`), then count and insert in one transaction:

```sql
-- inside the withOrg transaction (app.org_id set), after pg_advisory_xact_lock(org key)
select coalesce(sum(units), 0) as used
from usage_events
where org_id = current_setting('app.org_id')
  and kind = 'analysis'
  and refunded_at is null
  and occurred_at > now() - make_interval(secs => $window_seconds);
-- if used + $units > $limit: raise quota error (nothing inserted, transaction rolls back)
insert into usage_events (org_id, user_id, kind, units, run_id, video_id, plan_id, idempotency_key)
values (...);
```

Two concurrent requests for the same org serialize on the lock, so they cannot both spend the
last unit. A rolled-back request consumes nothing. `now()` is the transaction start time, which is
what we want. The index `(org_id, occurred_at)` keeps the count cheap.

**Per-user free cap** crosses orgs, which RLS hides from the web role on purpose. Use a
`SECURITY DEFINER` function `jams_free_units_used_by_user(user_id, window)` that returns only a
count, and take a per-user advisory lock **before** the per-org lock (fixed lock order prevents
deadlock). **Global free budget** uses a third lock and a count over free-plan rows, via the same
kind of function.

**Refunds**: set `refunded_at` and `refund_reason`, never delete. Refund when the failure is ours
(`transient`, `unknown`, watchdog stale). Do not refund `too_long` (the client declared a false
duration), `corrupt_file`, or runs the user superseded.

Lifetime counters in `recording_deletions.analysis_count` stop being used for quotas;
`usage_events` is never cascaded, so deleting a recording cannot restore quota.

### 6.3 What the user sees at a limit

HTTP 429 (window and budget limits), 413 (file too large), 403 with `code: "plan_required"`
(feature not in plan), each with `Cache-Control: no-store` and a stable JSON body:

```json
{
  "error": "You've used today's free evaluation.",
  "code": "quota_exceeded",
  "limit": "analysis_units",
  "plan": "free",
  "used": 1,
  "allowed": 1,
  "window": "PT24H",
  "retry_at": "2026-09-27T15:14:00Z",
  "upgrade_url": "/settings/plan"
}
```

429 responses also carry `Retry-After`. UI: a usage meter in the header and on Settings > Plan
("1 of 1 free evaluations used, next at 3:14 PM"); the upload dialog checks limits before the
upload starts (never after 500 MB have been sent); the Analyze and Re-analyze buttons show the
unit cost of the recording; members (non-admins) see "Ask an admin to upgrade" instead of an
upgrade button.

### 6.4 Abuse vectors and controls

| Vector | Controls |
|---|---|
| Many free accounts | Clerk bot protection, disposable-email and subaddress blocking, verified email; per-user free cap across orgs; Clerk per-user org-creation limit (2); **global free daily budget** as the hard ceiling |
| Huge files | Declared size capped at upload creation; actual size verified at finalize; SAS cannot enforce size, so uploads stuck in `uploading` over 24 h are swept and their declared bytes count toward storage until then; free plan limited to 3 concurrent uploads and 5 uploads per day |
| Lying about duration | Units computed from declared duration; worker enforces `max_duration_ms` from the charged units and fails `too_long` without refund |
| Re-analysis loops | Every run costs units; no refunds for user-initiated re-runs; bulk re-analyze shows the cost first; one active run per video |
| Automation through the API | API tokens only on paid plans; per-token HTTP rate limit (60 requests/min, 20 upload creations/hour); `Idempotency-Key` on POST `/api/analyses` stored in `usage_events` so client retries never double-spend; quotas identical to the UI |
| Egress through share links | Playback streams from Blob via SAS at $0.087/GB after 100 GB free; rate-limit SAS mints per share token; free-plan share links expire after 7 days; consider serving the normalized 1080p file instead of a 4K original |
| Card testing on Checkout | Hosted Checkout with Radar; checkout-session creation limited to admins and 10 per org per hour |
| Chargeback after heavy use | `charge.dispute.created` suspends new work for the org and alerts Chris |
| Pathological media | Worker normalizes to 1920 px; replica timeout bounds any single execution at about $0.43 |
| Database growth | Automation creates many `measures` rows (every spoken word is a row). Retention sweeps delete old runs with their recordings; watch the 32 GB B1ms volume (section 8) |

### 6.5 API tokens (for the planned API/MCP)

Format `jams_live_<prefix>_<secret>`; store only SHA-256 of the whole token and the prefix; show
the token once. Resolution: `Authorization: Bearer ...` goes to a resolver that sets
`app.api_token_hash`, reads the one matching row through an RLS policy (the 0014 share-token
pattern), checks `revoked_at` and the org's plan, then builds the same `OrgContext` as a session
(`userId = "token:<id>"`, role from the token). Rate limiting uses
`api_rate_windows (token_id, window_start, count)` with a single
`insert ... on conflict do update set count = count + 1 returning count`. The web app runs one
replica today, but Postgres keeps this correct when it scales out.

---

## 7. Rollout plan

Each phase is independently shippable, keeps production working, and has its own tests. Specs go
in `docs/specs/` per the delegation policy; Codex and Copilot implement, Claude reviews the
security-sensitive parts (withOrg changes, RLS, webhook handler).

| Phase | Ships | Behavior change | Tests |
|---|---|---|---|
| **P0 Chris** | Domain; Clerk production instance (already blocked on this); Stripe account in sandbox (5.9 steps 1 to 3); decisions in section 8 | none | n/a |
| **P1 Foundations** | `org_memberships` mirror, `orgs.created_by`, `orgRole` in `OrgContext`, `requireOrgAdmin`, `usage_events` written in **shadow mode** next to today's preview checks, RLS for new tables | none visible | webhook mirror tests; `rls-catalog` passes; concurrency test (two parallel admissions, one unit left) |
| **P2 Plans and quotas** | `lib/plans.ts`, `org_entitlements` (everyone Free; invited testers get a manual `preview` entitlement equal to today's `JAMS_PREVIEW_MAX_*`), `lib/usage-limits.ts` replaces `preview-limits.ts`, units and rolling window, per-user free cap, `max_duration_ms` on runs and in the worker probe, refunds, 429/413 bodies, usage meter UI | Invite-only preview continues; limits now come from plans | unit tests for unit math and windows; worker test that `max_duration_ms` fails `too_long`; e2e: second free evaluation blocked with the right message |
| **P3 Teams** | Org switcher (personal shown as "My workspace"), create team workspace, convert personal to team, members page (Clerk `<OrganizationProfile>`), admin-only gates, notification watcher scoped to the user's own runs (pre-launch review item), member caps via `maxAllowedMemberships` | Invited testers can invite teammates | e2e: invite, accept, member cannot open billing, admin can |
| **P4 Billing (sandbox)** | `/api/webhooks/stripe`, `billing_subscriptions`, checkout, portal, success-page sync, entitlement mapping, dispute suspension, Settings > Plan page | Upgrade works against the sandbox on staging | ledger tests (duplicate, out-of-order, in-progress); status-mapping table test; test-clock rehearsal |
| **P5 Open sign-up** | Clerk Pro, sign-up protections on, `JAMS_ACCESS_MODE=open`, global free budget, retention sweeps, worker `maxExecutions` 10, cost alerts (Azure budget alert and a daily units report), terms and privacy pages, Stripe live keys | Anyone can sign up to Free and upgrade | smoke on production with Chris's account; budget exhaustion rehearsal on staging |
| **P6 API tokens** | `api_tokens`, token resolver, rate windows, token UI for admins | Paid orgs can automate | token auth tests; RLS test for the hash policy; idempotency-key test |
| **Later** | Unit packs, annual prices, Clerk B2B add-on, enterprise SSO, metered overage on Stripe Meters | as needed | |

**From invite-only to open sign-up.**

1. Today: `JAMS_PREVIEW_USER_IDS` set means the allowlist gate plus preview limits.
2. P2 introduces `JAMS_ACCESS_MODE` with values `invite` and `open`. `invite` keeps the exact
   allowlist behavior in `proxy.ts` and `resolveOrgContext`, but quotas now come from each org's
   plan in both modes. For compatibility, `JAMS_PREVIEW_USER_IDS` present and `JAMS_ACCESS_MODE`
   unset means `invite`.
3. Before P5, every current preview org gets a manual `preview` entitlement with an end date (for
   example 60 days), so testers are not cut to one evaluation a day overnight.
4. P5 sets `JAMS_ACCESS_MODE=open`. The allowlist variable is then ignored, and anonymous share
   links work again as in the "variable absent" case documented in PREVIEW-READINESS.md.
5. The `JAMS_PREVIEW_MAX_*` settings are deleted one release later (two-push rule); the
   `preview` plan in `lib/plans.ts` replaces them.

Rollback at any phase: set `JAMS_ACCESS_MODE=invite` (closes sign-up); plans and quotas keep
protecting cost.

---

## 8. Risks and open questions for Chris

**Decisions needed**

1. **Prices and units.** $79 Pro at 1 unit/hour and $249 Team at 3 units/hour, 5 minutes per
   unit? Or literal per-hour windows? These are cost-safe, not market-tested.
2. **Free team workspaces.** Allow free team workspaces of up to 3 members (recommended, sharing
   one free unit a day), or make teams paid-only (simpler, and Clerk then only counts paying orgs)?
3. **Free recording cap.** 5 minutes and 500 MB? A longer cap raises free cost linearly.
4. **Retention on Free.** 30 days for recordings, then automatic deletion. Keep the report
   (measures, transcript) or delete it too? Recommendation: delete everything; privacy is simpler.
5. **Trials.** No card-free trial in v1 (free tier plays that role). Add a 14-day Team trial later?
6. **Business entity and tax.** Which entity and state is the seller of record? Determines
   Stripe Tax registration and whether tax is collected from the first sale.
7. **Refund policy** for the terms page (recommend: no prorated refunds on cancel, access to
   period end; goodwill refunds manually in the Stripe dashboard).

**Risks**

1. **Cost model rests on one measurement** of a silent 4K recording before the encoder change.
   Run `scripts/ops/pipeline-perf.sh` on narrated 1, 5 and 15 minute recordings on staging before
   publishing prices. If the ceiling is lower, prices can drop.
2. **Worker size mismatch.** The brief and PLAN.md say 2 vCPU / 4 GiB; the deployed job is
   4 vCPU / 8 GiB. Cost per evaluation is similar if scaling is near-linear, but this should be
   confirmed with the benchmark above.
3. **Global capacity is 3 concurrent analyses** (`maxExecutions: 3`). One automated customer can
   occupy it. Raise before paid plans and consider per-org fair dispatch from the existing
   dispatch outbox later.
4. **Environment core quota** for 10 concurrent 4-vCPU executions was not verified.
5. **Postgres growth.** Word-level measures from automated plans can add hundreds of MB a month
   per busy org on a 32 GB B1ms volume. Retention sweeps are required, and storage size should be
   watched.
6. **Egress is the one cost quotas do not bound.** A popular share link on a 2 GB recording costs
   $0.17 per full view after the free 100 GB. The share-link rate limit matters.
7. **SAS cannot enforce upload size.** A client can write more than it declared before finalize
   rejects it. Declared bytes count against storage, stuck uploads are swept, but physical bytes
   can briefly exceed the cap (already documented in PREVIEW-READINESS.md).
8. **Clerk plan details not fully verified**: which sign-up protections are on Hobby versus Pro,
   whether SCIM is included with Pro's enterprise connection, and the pricing page's ambiguous
   "custom domain" line for Hobby (Clerk's deployment docs require a domain we own for any
   production instance; the pre-launch review found it free on Hobby).
9. **Clerk's `createRouteMatcher` is deprecated** (pre-launch review). `proxy.ts` changes in P2
   and P5 are a good moment to migrate.
10. **Stripe webhook secret and restricted key** are new production secrets; add them to the
    runbook's secret list and rotation notes.

---

## Sources (read September 26, 2026)

- Clerk pricing: https://clerk.com/pricing
- Clerk pricing explained (MRU, MRO, overage, SSO tiers, first-day-free): https://clerk.com/articles/clerk-pricing-explained
- Clerk organizations overview: https://clerk.com/docs/guides/organizations/overview
- Clerk production deployment (own domain, own OAuth credentials): https://clerk.com/docs/guides/development/deployment/production
- Clerk Billing overview (no tax, no refunds, USD only): https://clerk.com/docs/guides/billing/overview
- Clerk org-creation limits: https://clerk.com/changelog/2024-08-13-limit-org-creation
- Clerk restricting access (disposable email, subaddresses): https://clerk.com/docs/guides/secure/restricting-access
- Clerk bot protection: https://clerk.com/docs/guides/secure/bot-protection
- Microsoft Entra External ID pricing page: https://www.microsoft.com/en-us/security/pricing/microsoft-entra-external-id
- External ID billing model (MAU, add-ons, subscription link): https://learn.microsoft.com/en-us/entra/external-id/external-identities-pricing
- External ID $0.03/MAU above 50,000 (via search summary of Microsoft's GA announcement and third-party pricing trackers; **not confirmed on a Microsoft price table**): https://techcommunity.microsoft.com/blog/microsoft-entra-blog/announcing-general-availability-of-microsoft-entra-external-id/3974961
- External tenant features (invitations admin-only, federation, groups/app roles): https://learn.microsoft.com/en-us/entra/external-id/customers/concept-supported-features-customers
- External ID custom URL domains (Azure Front Door): https://learn.microsoft.com/en-us/entra/external-id/customers/concept-custom-url-domain
- External ID Node sample (no Next.js sample found): https://learn.microsoft.com/en-us/entra/external-id/customers/sample-web-app-node-sign-in
- Azure Front Door pricing: https://azure.microsoft.com/en-us/pricing/details/frontdoor/
- Auth0 pricing: https://auth0.com/pricing
- WorkOS pricing: https://workos.com/pricing
- WorkOS AuthKit users and organizations: https://workos.com/docs/authkit/users-organizations
- Stytch pricing: https://stytch.com/pricing
- Better Auth organization plugin: https://www.better-auth.com/docs/plugins/organization
- Better Auth SSO plugin: https://better-auth.com/docs/plugins/sso
- Azure Container Apps billing (free grant, jobs at active rate): https://learn.microsoft.com/en-us/azure/container-apps/billing
- Azure Container Apps pricing: https://azure.microsoft.com/en-us/pricing/details/container-apps/
- Azure Retail Prices API (ACA meters, East US 2; Postgres B1MS $0.017/hour; Hot LRS $0.0184/GB): https://prices.azure.com/api/retail/prices
- Azure Container Apps quotas: https://learn.microsoft.com/en-us/azure/container-apps/quotas
- Azure Blob Storage pricing: https://azure.microsoft.com/en-us/pricing/details/storage/blobs/
- Azure bandwidth pricing (100 GB free, then $0.087/GB): https://azure.microsoft.com/en-us/pricing/details/bandwidth/
- Stripe pricing (2.9% + 30c, Billing 0.7%, Tax 0.5%): https://stripe.com/pricing
- Stripe subscription webhooks and statuses: https://docs.stripe.com/billing/subscriptions/webhooks
- Stripe portal scheduled downgrades: https://docs.stripe.com/changelog/acacia/2024-10-28/customer-portal-schedule-downgrades
- Stripe legacy usage-based billing removed in 2025-03-31.basil: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing
- Repo: `docs/PIPELINE-PERF-2026-09-19.md`, `docs/benchmarks/whisper-local.md`, `docs/PREVIEW-READINESS.md`, `docs/reviews/PRE-LAUNCH-REVIEW-2026-09-23.md`, `infra/resources.bicep`
