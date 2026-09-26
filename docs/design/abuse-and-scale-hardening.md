# Abuse and scale hardening

September 26, 2026. Threat and load model for JAMS, the controls that bound each threat, where
they live in code, how to tune them, and what they cost. Written for the `hardening-abuse`
branch. Billing, plans and the free tier are designed separately
(`docs/design/tenancy-auth-billing.md`, on another branch); this document only makes sure every
limit has one home that a plan can later feed.

## Goals

1. **Cost stays flat when something goes wrong.** A viral spike, one abusive account or a script
   must not be able to turn the Azure bill into an open-ended number. Every expensive resource
   has a ceiling that is enforced in code or in Bicep, not only by an alert.
2. **Legitimate users get a clear answer.** Limits return 429 with `Retry-After` and a sentence a
   person can act on; the upload dialog rejects a recording before a single byte is uploaded.
3. **One policy module.** Every limit is read through `apps/web/src/lib/limits.ts`. Today the
   values come from environment variables; later a customer's plan entitlements can override them
   per organization without touching the call sites.
4. **No new service.** Everything runs inside `jams-web`, `jams-worker` and Postgres (hard rule 5).
   There is no Redis and no WAF; rate limiting is Postgres-backed.

## How the system spends money

| Resource | What drives cost | Ceiling before this change |
| --- | --- | --- |
| `jams-worker` ACA Job (4 vCPU, 8 GiB) | Seconds each execution runs | `maxExecutions: 3`, `replicaTimeout: 3600`. **Each execution ran the infinite poll loop, so it lived the full hour even after one short job.** |
| `jams-web` Container App (0.5 vCPU, 1 GiB) | Replica seconds + requests | `maxReplicas: 1` |
| Blob Storage (Hot LRS) | GB stored, egress to the internet | None in the app outside preview. SAS cannot cap an upload's size. |
| Postgres Flexible B1ms | Fixed hourly | 35 user connections (50 minus 15 reserved) |
| Log Analytics | GB ingested | 1 GB/day cap (already in Bicep) |

## Prices used (read September 26, 2026)

Retail prices from the Azure Retail Prices API for `eastus2`, pay-as-you-go, USD:

- Container Apps Consumption: vCPU active **$0.000024/s**, vCPU idle $0.000003/s, memory
  **$0.000003/GiB-s** (active and idle), requests **$0.40 per million**. Free grant per subscription
  per month: 180,000 vCPU-s, 360,000 GiB-s, 2 million requests. Jobs are billed "at the active rate
  from its start to completion". Sources:
  <https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Azure%20Container%20Apps'%20and%20armRegionName%20eq%20'eastus2'>,
  <https://azure.microsoft.com/en-us/pricing/details/container-apps/>,
  <https://learn.microsoft.com/en-us/azure/container-apps/billing>.
  The "Environment Management Hour" meter ($0.10/h) applies to dedicated workload profiles,
  private endpoints and planned maintenance, none of which this environment uses.
- Blob Storage, General Block Blob v2, LRS: Hot **$0.0184/GB-month**, Cool $0.01/GB-month; Hot
  writes $0.05 per 10,000, Hot reads $0.004 per 10,000. Source:
  <https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Storage'%20and%20armRegionName%20eq%20'eastus2'%20and%20productName%20eq%20'General%20Block%20Blob%20v2'>,
  <https://azure.microsoft.com/en-us/pricing/details/storage/blobs/>.
- Internet egress from US East 2 (Microsoft network routing): first 100 GB/month free, then
  **$0.087/GB**. Source: Retail Prices API, `serviceName eq 'Bandwidth'`.
- Postgres Flexible Server B1ms: $0.017/h (about $12.41/month). B1ms allows 50 connections, 35 for
  users. Sources: Retail Prices API (`Azure Database for PostgreSQL`),
  <https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-limits>.
- Log Analytics: $2.76/GB after 5 GB/month free. Source: Retail Prices API (`Log Analytics`).
- Azure Front Door (for comparison only, not deployed): Standard $35/month base plus requests,
  WAF policy $5/month plus $1 per custom rule; Premium $330/month base (managed rule sets, bot
  protection). Source: Retail Prices API (`Azure Front Door Service`),
  <https://azure.microsoft.com/en-us/pricing/details/frontdoor/>.

Derived unit costs:

- One worker execution-hour: 4 vCPU x 3600 s x $0.000024 + 8 GiB x 3600 s x $0.000003 =
  **$0.432**.
- One always-on web replica-day: 0.5 x 86,400 x $0.000024 + 1 x 86,400 x $0.000003 = **$1.30**.

## Threats, controls and knobs

"Implemented" means it is in this branch with tests. "Recommended" means a manual step or a later
slice; see the last section.

### 1. Viral spike (many honest users at once)

- **Risk:** sign-ups arrive faster than the worker can process; the queue and the bill grow
  together, and Postgres runs out of connections if web scales out.
- **Controls (implemented):**
  - Global in-flight analysis cap, a circuit breaker: when queued plus running analyses across all
    organizations reach the cap, new analyses get 429 with `Retry-After: 300`. The spike waits in the
    UI instead of in an unbounded queue. `assertAnalysisAdmission` in
    `apps/web/src/lib/preview-limits.ts`, counted by the `jams_global_active_analysis_count()`
    security-definer function (migration `0015_abuse_hardening.sql`) under a global transaction
    advisory lock, so two requests cannot both take the last slot.
    Knob: `JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES` (default 30).
  - Global daily upload-bytes circuit breaker: new recordings in the last 24 hours across all
    organizations may declare at most this many bytes. Knob:
    `JAMS_LIMIT_GLOBAL_UPLOAD_BYTES_PER_DAY` (default 200 GiB).
  - Scale-out bounded in Bicep with parameters (`webMaxReplicas`, `workerMaxExecutions`,
    `workerParallelism`, `workerReplicaTimeoutSeconds`, `workerPollingIntervalSeconds`), each with
    `@minValue/@maxValue` so a typo cannot deploy an unbounded fleet. `webMaxReplicas` is capped at
    2 because each replica holds up to 13 Postgres connections (web pool 10 + admin pool 3) and B1ms
    has 35 user connections. Defaults are today's values.
  - Worker executions now exit when the queue is empty (`--drain`, Bicep `workerDrainMode`,
    default on). Previously every KEDA-started execution kept polling until the one-hour
    `replicaTimeout` killed it, billing a full $0.43 execution-hour for a job that may have taken a
    minute, and killing any job still running at the hour mark.
- **Cost impact:** worker spend is bounded by `workerMaxExecutions x 24 h x $0.432`, about
  **$31/day** at the default of 3, no matter how many requests arrive. Scale-to-zero is unchanged for
  both units.

### 2. One abusive account

- **Risk:** one tenant uploads huge files, re-runs analyses in a loop, or scripts the API.
- **Controls (implemented):**
  - Per-organization storage cap on declared original bytes, now enforced outside preview too.
    Knob: `JAMS_LIMIT_ORG_STORAGE_BYTES` (default 10 GiB; in preview
    `JAMS_PREVIEW_MAX_STORAGE_BYTES` still wins).
  - Per-organization active analyses (queued plus running, including superseded ones). Knob:
    `JAMS_LIMIT_ORG_ACTIVE_ANALYSES` (default 5; in preview `JAMS_PREVIEW_MAX_ACTIVE_RUNS`).
  - Per-organization analyses per rolling window, counting runs of deleted recordings too, so
    delete-and-retry does not reset it. Knobs: `JAMS_LIMIT_ORG_ANALYSES_PER_WINDOW` (default 50),
    `JAMS_LIMIT_ORG_ANALYSIS_WINDOW_SECONDS` (default 86400).
  - Optional lifetime cap: `JAMS_LIMIT_ORG_TOTAL_ANALYSES` (unset means none; in preview
    `JAMS_PREVIEW_MAX_ANALYSES`, default 100).
  - All per-organization checks run under the existing per-organization transaction advisory lock,
    so concurrent requests cannot both claim the last unit.
  - Per-user request rate limits on upload creation and analysis creation (Postgres fixed window,
    see section 4). Knobs: `JAMS_RATE_UPLOAD_CREATE` (default `30/3600`),
    `JAMS_RATE_ANALYSIS_CREATE` (default `30/3600`).
- **Cost impact:** one account can hold at most 5 of the 30 global slots, so it cannot starve
  everyone else, and at most 50 analyses per day, about 50 x 20 min x 4 vCPU = at most roughly
  $7/day of worker time even with maximum-length recordings.

### 3. Many free accounts (sign-up farming)

- **Risk:** per-account limits multiply by the number of accounts a script can create.
- **Controls:** the global circuit breakers in section 1 are what bound this (implemented). Bot
  friction at sign-up belongs to the auth provider (recommended, manual): enable Clerk's bot
  protection (Cloudflare Turnstile) on sign-up, require email verification, and block disposable
  email domains in the Clerk dashboard. The free-tier plan (1 evaluation per day with a size cap)
  plugs in as per-organization entitlements through `resolveLimitPolicy`.
- **Cost impact:** bounded by the global caps regardless of account count.

### 4. Scripted API clients and request floods

There is no MCP server or public API in the codebase today; "scripted clients" means scripts that
drive the same routes the browser uses with a real session, or unauthenticated floods.

- **Controls (implemented):** `apps/web/src/lib/rate-limit.ts`, a fixed-window counter in the
  `rate_limit_counters` table (one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per
  request). Keys are SHA-256 hashed, so client IPs are not stored. A request that is refused caches
  "blocked until" in process memory, so a flood from one key stops touching Postgres after the first
  refusal. Rate limiting runs before `withOrg` opens its transaction, so it never holds two pool
  connections at once. Expired rows are purged by the watchdog.

  | Endpoint | Key | Knob | Default |
  | --- | --- | --- | --- |
  | `POST /api/videos` (upload create, mints SAS) | user | `JAMS_RATE_UPLOAD_CREATE` | 30 per hour |
  | `POST /api/analyses` | user | `JAMS_RATE_ANALYSIS_CREATE` | 30 per hour |
  | `/share/[token]` (public report) | client IP | `JAMS_RATE_SHARE_VIEW_IP` | 60 per 10 min |
  | `/share/[token]` | share token | `JAMS_RATE_SHARE_VIEW_TOKEN` | 1000 per day |
  | `POST /api/webhooks/clerk` | client IP | `JAMS_RATE_WEBHOOK_IP` | 300 per minute |

  Webhook bodies are capped at `JAMS_WEBHOOK_MAX_BODY_BYTES` (default 1 MiB) before signature
  verification. Client IP comes from `X-Forwarded-For`, counting `JAMS_TRUSTED_PROXY_HOPS` (default
  1, the Container Apps ingress) from the right, because the left-most entries are client-supplied.
  IPv6 clients are keyed by their /64. `JAMS_RATE_LIMITS_ENABLED=false` switches request rate
  limiting off (quotas stay on) as an emergency lever.
- **What Front Door plus WAF would add (not deployed):** blocking before requests reach the app
  (Container Apps still bills every request that arrives, $0.40 per million), geo and IP rules, bot
  classification and managed OWASP rules, edge caching of playback. Standard costs about $35/month
  plus $5/month per WAF policy and $1 per custom rule plus per-request fees; managed rules and bot
  protection need Premium at $330/month. Not worth it before there is a paying customer or a real
  flood; revisit if request charges ever show up on the bill.
- **Cost impact:** an HTTP flood is the one path the app cannot fully stop: every request is billed
  even when answered with 429. A single 0.5 vCPU replica can answer a few hundred cheap 429s per
  second; 500 req/s for a day is about 43 million requests, about **$17/day**. Budget and request
  metric alerts (below) are the control; Front Door is the upgrade.

### 5. Oversized or malformed media

- **Controls (implemented):**
  - Browser, before upload (`apps/web/src/lib/upload-validation.ts`, used by `UploadDialog`):
    container type, size, duration, and a decodable video track (a file whose video the browser
    cannot decode reports 0x0 dimensions, which is how an unsupported codec shows up), plus a clear
    message for recordings whose length the browser cannot determine. Limits come from
    `GET /api/limits`, which reads the same policy as the server.
  - Server at create (`POST /api/videos`): declared size against `JAMS_LIMIT_UPLOAD_MAX_BYTES`
    (default and hard ceiling 2 GiB) and, when the client sends it, declared duration against
    `JAMS_LIMIT_UPLOAD_MAX_DURATION_MS` (default 20 minutes).
  - Server at finalize (`POST /api/videos/:id/complete`), the authoritative check because a write
    SAS cannot cap size: the blob's actual `Content-Length` must equal the declared size and be
    within the limit. A mismatched or oversized blob is **deleted** and the recording marked failed.
    The poster must be at most `JAMS_LIMIT_POSTER_MAX_BYTES` (default 5 MiB); an oversized poster is
    deleted and the recording finalizes without it.
  - Worker, before heavy work (`worker/src/jams_worker/providers/probe.py`): checks the blob's size
    before downloading (`too_large`), then ffprobe's duration (`too_long`) and pixel count
    (`unsupported_media`, knob `JAMS_LIMIT_MAX_VIDEO_PIXELS`, default 7680x4320) before the
    normalization encode. These are terminal error codes: the run fails on the first attempt and is
    not retried.
- **Cost impact:** a bad upload now costs at most the 15-minute SAS window of ingress (free) and a
  few seconds of worker time, instead of up to three full processing attempts.

### 6. Re-analysis loops

- **Controls (implemented):** the per-organization active and rolling-window caps count every
  analysis, including superseded ones, and bulk re-analysis (the journey "re-analyze outdated"
  action in the U2 stack) goes through the same `assertAnalysisAdmission`, stopping at the first
  limit. Double-submits are idempotent: a second `POST /api/analyses` for a recording that already
  has a queued or running analysis with the same configuration returns that analysis (200) instead
  of creating another.
- **Recommended:** let the worker skip a queued run that was superseded before it started (today it
  still processes it). Kept out of this branch because it changes run history semantics that the
  U2 comparisons read.

### 7. Slow-loris uploads and abandoned uploads

- **Risk:** uploads go straight to Blob Storage, so a slow client never ties up the web app, but an
  abandoned or hostile upload can leave blobs behind: a recording stuck in `uploading`, or bytes
  written to the client upload path after the server made its own finalized copy (the upload SAS
  stays valid for 15 minutes).
- **Controls (implemented):** the watchdog (every 10 minutes) now also
  - marks recordings still `uploading` after `JAMS_LIMIT_STALE_UPLOAD_MINUTES` (default 60, well
    past the 15-minute SAS) as failed, and
  - once the upload SAS has expired, deletes the client-writable upload paths (original and poster)
    of every finalized or failed recording and records `videos.upload_sources_cleaned_at`. For
    finalized recordings this removes the duplicate copy (the analysis and playback use the
    server-owned finalized copy), roughly halving stored bytes per recording. A failed upload whose
    blobs are verified deleted stops counting against the organization's storage cap.
  - `apps/web/src/lib/upload-cleanup.ts`, called from `/api/admin/watchdog`; batch size bounded.
- Slow request bodies to the web app itself: Next.js route handlers here read small JSON bodies;
  the webhook route now refuses bodies over 1 MiB. The Container Apps ingress (Envoy) enforces its
  own request timeouts.
- **Recommended lifecycle policy:** move client upload paths to their own container (for example
  `uploads/`) in a later slice so a Blob lifecycle rule can delete anything older than 1 day there
  as a platform-level backstop. Today upload and finalized blobs share the `videos/{org}/{video}/`
  prefix, and lifecycle rules can only match by prefix, so a rule cannot tell them apart. Keep the
  existing "cool after 30 days" rule. Consider a rule moving `derived/` to Cool after 30 days too.

### 8. Queue floods

- **Risk:** messages on `analysis-jobs` wake worker executions.
- **Controls (implemented):** only the web app can enqueue (the storage key is server-side), and it
  only enqueues after a run row passes admission, so the queue can never be deeper than the global
  in-flight cap plus a few reconciliation retries. Poison handling is unchanged: three dequeues,
  then `analysis-jobs-poison`; terminal media errors poison on the first attempt. KEDA can never
  start more than `workerMaxExecutions` executions.

### 9. Playback and share-link egress

- **Risk:** playback streams straight from Blob with a 60-minute read SAS. Egress beyond 100 GB a
  month costs $0.087/GB, and nothing in Azure Storage can cap the bytes a valid SAS reads. A viral
  share link multiplies this.
- **Controls:** share page loads are rate limited per link and per IP (implemented), which bounds
  how many SAS URLs are handed out. The bytes read per SAS are not bounded.
- **Worst case:** 1000 share views/day of a 200 MB recording that each download it fully is 200 GB,
  about **$17/day**. A determined client re-downloading a 2 GiB recording with one SAS for an hour at
  1 Gbit/s could pull about 450 GB, about $39. This is the one cost an in-app control cannot cap;
  the storage egress metric alert below is the tripwire, and rotating the storage account key
  invalidates every outstanding SAS as an emergency stop.

## Cost ceiling with the proposed defaults

Worst case per day, every control saturated at once, sustained for 24 hours:

| Item | Ceiling/day | Why it is bounded |
| --- | ---: | --- |
| Worker compute | $31.10 | 3 executions x 24 h x $0.432 (Bicep `workerMaxExecutions`) |
| Web compute | $1.30 | 1 replica x $1.30 (Bicep `webMaxReplicas`) |
| Web requests under a flood | ~$17 | Replica throughput; not bounded by app code |
| Postgres B1ms | $0.41 | Fixed |
| Log Analytics | $2.76 | 1 GB/day cap |
| New storage | +$0.12 per day of max uploads, cumulative | 200 GiB/day global upload cap x $0.0184/GB-month / 30 |
| Egress | ~$17 typical worst, not hard-capped | Share views rate limited; bytes per SAS are not |
| **Total, excluding egress and floods** | **about $36/day** | |
| **Total, with a request flood and share-link egress** | **about $70/day** | |

The free grant (180,000 vCPU-s per month) absorbs about 12.5 worker execution-hours a month, so
normal use stays near today's $0 to $3/month idle cost; with `--drain` the worker no longer burns an
hour per execution.

For comparison, before this branch: the same $31/day worker ceiling existed, but it was reached by
ordinary use (every execution idled to the one-hour timeout), and storage, analysis counts and
request rates had no ceiling at all outside preview.

## Recommended Azure budget alerts (manual)

Chris sets these in the portal (Cost Management, Budgets, scope `rg-jams-staging`, and later
production). Budgets only notify; they do not stop spend, and cost data lags by up to a day, so pair
them with metric alerts that fire within minutes.

1. **Monthly budget $50** on the resource group with alerts at 50% and 80% actual, and 100%
   forecasted. Normal staging is under $25/month.
2. **Monthly budget $150** "something is wrong" with an alert at 100% actual, routed to phone
   (action group with SMS or push).
3. **Metric alerts** (Azure Monitor, 5-minute evaluation):
   - Storage account `Egress` over 20 GB in 1 hour.
   - Storage account `UsedCapacity` over 500 GB.
   - Container Apps job `jams-worker`: executions running at `workerMaxExecutions` for over 2 hours.
   - Container App `jams-web`: `Requests` over 100,000 in 5 minutes.
   - Postgres `active_connections` over 30 (of 35 user connections).
4. **Emergency levers**, documented in `docs/OPERATIONS-RUNBOOK.md`: set
   `JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES=1` and redeploy to stop new work; scale the worker job's
   max executions to 0; rotate the storage key to revoke every SAS.

## Implemented vs recommended

**Implemented in this branch (with tests):** central policy module; client pre-upload validation
from server limits; server declared-size and duration checks; finalize-time size verification with
delete; poster size cap; worker size, duration and pixel checks before heavy work with terminal
error codes; per-organization storage, active, rolling-window and lifetime analysis caps outside
preview; global in-flight and daily upload-bytes circuit breakers; idempotent analysis creation;
Postgres-backed rate limits on upload create, analysis create, share views and webhooks; webhook
body cap; 429 with `Retry-After`; stale upload and upload-source cleanup in the watchdog; Bicep
parameters with bounds for replicas, executions, parallelism, polling and timeout; worker drain mode.

**Recommended, needs Chris or a later slice:** Clerk bot protection, email verification and
disposable-domain blocking; Azure budgets and metric alerts above; the separate `uploads` container
with a delete-after-1-day lifecycle rule; `derived/` to Cool after 30 days; worker skipping
superseded queued runs; counting derived artifacts toward storage; Front Door plus WAF only if
request floods appear; hashing share tokens at rest (already on the pre-launch list).
