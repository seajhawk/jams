# Cloudflare for JAMS: evaluated, not adopted

September 22, 2026. Prompted by the A Little Hill Farm site being deployed to Cloudflare Workers.
Decision: **JAMS stays on Azure.** Two Cloudflare pieces are worth revisiting later, and one is
worth taking now because it costs nothing and moves nothing.

## What ALHF uses, and why it fits there

`D:\git\ALittleHillFarm\website` runs two Workers:

- `alhf-site`: static assets from `dist-site/`, `not_found_handling = "404-page"`,
  `html_handling = "none"` so hand written links keep their `.html` form.
- `alhf-store`: D1 (SQLite) for the store, R2 for media, and
  `run_worker_first = ["/admin", "/admin/*", "/api/*"]` so the auth check runs before the edge can
  serve a matching asset from cache.

That is a small static site plus a small dynamic store. It sits inside the Workers Paid plan at
$5/month with D1 and R2 inside their free tiers. Nothing about that choice is wrong.

## Why JAMS is a different shape

### The Python worker cannot run on Workers

Worker isolates get 128 MB of memory and at most 5 minutes of CPU. ffmpeg, OpenCV, onnxruntime and
whisper are not candidates.

### Cloudflare Containers could run it, but the rewrite is in the wrong place

The largest container instance is `standard-4`: 4 vCPU, 12 GiB, 20 GB disk. That is the size we
just moved the worker to, so the compute itself fits.

The problem is the control plane. Containers are driven by Durable Objects, not a queue. Our
dispatch path (queue visibility renewal, DB leases, poison queue, KEDA scale from zero) would be
rewritten against a different primitive, and that is the code whose job is to stop two workers
processing the same run. Rewriting the concurrency-safety layer to save nothing is a bad trade.

### The compute economics are a wash

A 150 second run at 4 vCPU and 12 GiB:

| Component | Amount | Rate | Cost |
| --- | --- | --- | --- |
| vCPU | 600 vCPU-s | $0.000020 | $0.012 |
| Memory | 1,800 GiB-s | $0.0000025 | $0.0045 |
| **Per run** | | | **about $0.017** |

Workers Paid includes 375 vCPU-minutes and 25 GiB-hours per month, which covers roughly 37 runs of
that size. Azure Container Apps consumption pricing lands in the same range. There is no saving
here, only a migration.

### Postgres and RLS is the real blocker

Cloudflare has no managed Postgres. D1 is SQLite and has no row-level security. JAMS isolates
tenants with RLS (`videos_org_isolation` FOR ALL with WITH CHECK), and re-implementing that in
application code for a multi-tenant product is precisely the regression to avoid.

The alternative is keeping Postgres elsewhere and fronting it with Hyperdrive. One detail in our
favour if that ever happens: `with-org.ts` sets the tenant with
`select set_config('app.org_id', $1, true)` inside a transaction, and the `true` makes it
transaction-scoped, so Hyperdrive's transaction-mode pooling would not break it. But this adds a
vendor rather than removing one.

### The web app could move, with caveats

OpenNext supports Next.js 16 on Workers using the Node runtime. Node middleware (Next 15.2+) is not
supported, so Clerk's middleware would need checking, and there is a 10 MiB compressed Worker size
limit on the paid plan. Possible, but it buys nothing on its own while the worker and database stay
on Azure.

## The one piece genuinely worth wanting: R2

R2 charges **nothing for egress**. Azure Blob charges about $0.087/GB past the first 100 GB a month.

JAMS is a video product. Every report view streams a file, so egress is the single line on the bill
that grows with success rather than with headcount.

| Scenario | Azure Blob egress | R2 |
| --- | --- | --- |
| 100 recordings x 30 MB x 10 views = 30 GB/mo | about $2.60 | $0 |
| Ten times that | about $26 | $0 |

Storage is slightly cheaper too: $0.015/GB-month against roughly $0.018 to $0.021 for Azure Hot LRS.

R2 is S3-compatible, so presigned URLs drop straight into the SAS slot and the browser upload flow
is unchanged. It is the cleanest swap available anywhere in the stack.

**Not yet.** Today's egress bill is near zero, and splitting storage across two clouds costs a
second bill, a second credential set, and the loss of the managed-identity path for blob access
that is still on the roadmap.

**Revisit when** monthly blob egress passes about $20, or when shared reports start drawing many
viewers per recording. The migration is a provider swap in `lib/blob.ts` plus a copy of existing
objects, so the cost of waiting is low.

## What to take now, for free

Put Cloudflare DNS in front of the Container App once JAMS has a real domain. Proxied DNS on the
free plan gives DDoS protection, a WAF and static asset caching without moving a single Azure
resource. No migration, no lock-in, reversible by flipping the orange cloud off.

## Email: staying with Azure Communication Services

Cloudflare now has an Email Service with outbound sending: 3,000 messages a month included on
Workers Paid, then $0.35 per thousand, with SPF, DKIM and DMARC configured automatically. The
economics beat what `docs/specs/f11-analysis-notifications.md` proposed.

It still loses on fit. The native binding is Workers-only and our sender is Python running in
Azure, so using it would mean standing up a Worker purely to relay mail: a cross-cloud hop and a
second vendor for one function.

Azure Communication Services Email stays the choice. Same cloud, same bicep file, same credential
model, free `azurecomm.net` domain with no DNS to configure. Cloudflare Email would only win if the
web app were already running on Workers.

## Summary

| Piece | Verdict |
| --- | --- |
| Python worker to Containers | No. Rewrites the concurrency-safety layer for no saving. |
| Postgres to D1 | No. Loses RLS tenant isolation. |
| Next.js app to Workers | No value while the rest stays on Azure. |
| Blob to R2 | Later. Real saving, but only once egress is visible on the bill. |
| Cloudflare DNS in front of ACA | Yes, when there is a domain. Free, reversible. |
| Cloudflare Email Service | No. Better price, wrong fit for an Azure-hosted sender. |

Sources: Cloudflare docs for [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/),
[Containers pricing](https://developers.cloudflare.com/containers/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), and
[OpenNext for Cloudflare](https://opennext.js.org/cloudflare). Read September 22, 2026.
