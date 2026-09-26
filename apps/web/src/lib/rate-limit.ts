import { createHash } from "node:crypto"
import { lt, sql } from "drizzle-orm"

import { db } from "@/db/client"
import { rateLimitCounters } from "@/db/schema"
import {
  LimitExceededError,
  resolveLimitPolicy,
  type LimitPolicy,
  type RateLimitName,
} from "@/lib/limits"

/**
 * Postgres-backed fixed-window rate limiting, shared by every web replica.
 *
 * One atomic upsert per request counts it in the current window. A refused key is remembered in
 * this process until its window ends, so a flood from one key stops reaching Postgres after its
 * first refusal. Keys are SHA-256 hashed before storage; no user id, token or IP is stored.
 *
 * Call it BEFORE opening a request transaction (`withOrg` does this for its `rateLimit` option):
 * it uses its own pooled connection, and taking a second connection while holding one can
 * deadlock a saturated pool.
 *
 * Availability over strictness: if the counter write fails (database blip, migration not yet
 * applied), the request is allowed and the error logged. Quotas, which guard cost, stay fail-closed.
 */

export type RateLimitDecision = {
  allowed: boolean
  limit: number
  hits: number
  retryAfterSeconds: number
}

type CounterStore = {
  increment(bucket: string, windowStart: Date, expiresAt: Date): Promise<number>
}

const MAX_BLOCKED_ENTRIES = 10_000
const blockedUntil = new Map<string, number>()

const postgresStore: CounterStore = {
  async increment(bucket, windowStart, expiresAt) {
    const [row] = await db
      .insert(rateLimitCounters)
      .values({ bucket, windowStart, hits: 1, expiresAt })
      .onConflictDoUpdate({
        target: [rateLimitCounters.bucket, rateLimitCounters.windowStart],
        set: { hits: sql`${rateLimitCounters.hits} + 1` },
      })
      .returning({ hits: rateLimitCounters.hits })
    return row?.hits ?? 1
  },
}

export function rateLimitBucket(name: RateLimitName, subject: string): string {
  return createHash("sha256").update(`${name}\u0000${subject}`).digest("hex").slice(0, 40)
}

function rememberBlocked(key: string, until: number) {
  if (blockedUntil.size >= MAX_BLOCKED_ENTRIES) {
    const oldest = blockedUntil.keys().next().value
    if (oldest !== undefined) blockedUntil.delete(oldest)
  }
  blockedUntil.set(key, until)
}

/** Test seam: forget refusals cached in this process. */
export function resetRateLimitCacheForTests() {
  blockedUntil.clear()
}

export async function consumeRateLimit(
  name: RateLimitName,
  subject: string,
  options: { policy?: LimitPolicy; now?: number; store?: CounterStore } = {}
): Promise<RateLimitDecision> {
  const policy = options.policy ?? resolveLimitPolicy()
  const rule = policy.rates[name]
  const now = options.now ?? Date.now()
  const windowMs = rule.windowSeconds * 1000
  const windowStart = Math.floor(now / windowMs) * windowMs
  const windowEnd = windowStart + windowMs
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - now) / 1000))

  if (!policy.rateLimitsEnabled) {
    return { allowed: true, limit: rule.limit, hits: 0, retryAfterSeconds: 0 }
  }

  const bucket = rateLimitBucket(name, subject)
  const cached = blockedUntil.get(bucket)
  if (cached !== undefined) {
    if (cached > now) {
      return {
        allowed: false,
        limit: rule.limit,
        hits: rule.limit + 1,
        retryAfterSeconds: Math.max(1, Math.ceil((cached - now) / 1000)),
      }
    }
    blockedUntil.delete(bucket)
  }

  let hits: number
  try {
    hits = await (options.store ?? postgresStore).increment(
      bucket,
      new Date(windowStart),
      new Date(windowEnd)
    )
  } catch (error) {
    console.error("rate_limit_store_error", {
      name,
      error: error instanceof Error ? error.message : String(error),
    })
    return { allowed: true, limit: rule.limit, hits: 0, retryAfterSeconds: 0 }
  }

  if (hits > rule.limit) {
    rememberBlocked(bucket, windowEnd)
    return { allowed: false, limit: rule.limit, hits, retryAfterSeconds }
  }
  return { allowed: true, limit: rule.limit, hits, retryAfterSeconds }
}

export async function enforceRateLimit(
  name: RateLimitName,
  subject: string,
  options: { policy?: LimitPolicy; now?: number; store?: CounterStore; message?: string } = {}
): Promise<void> {
  const decision = await consumeRateLimit(name, subject, options)
  if (!decision.allowed) {
    throw new LimitExceededError(
      options.message ?? "Too many requests. Please slow down and try again shortly.",
      "rate",
      decision.retryAfterSeconds
    )
  }
}

/** Deletes counters whose window has ended. Called by the watchdog. */
export async function purgeExpiredRateLimitCounters(now = new Date()): Promise<number> {
  const deleted = await db
    .delete(rateLimitCounters)
    .where(lt(rateLimitCounters.expiresAt, now))
    .returning({ bucket: rateLimitCounters.bucket })
  return deleted.length
}

function expandIpv6(address: string): string[] | null {
  const [head, tail, ...rest] = address.split("::")
  if (rest.length > 0) return null
  const headParts = head ? head.split(":") : []
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : []
  const missing = 8 - headParts.length - tailParts.length
  if (tail === undefined ? headParts.length !== 8 : missing < 0) return null
  return [...headParts, ...Array(tail === undefined ? 0 : missing).fill("0"), ...tailParts]
}

/**
 * The client address to rate limit on. The Container Apps ingress appends the connecting address
 * to `X-Forwarded-For`; anything to its left was supplied by the client and cannot be trusted, so
 * count `JAMS_TRUSTED_PROXY_HOPS` (default 1) entries from the right. IPv6 clients are keyed by
 * their /64, since one host usually controls a whole /64.
 */
export function clientAddress(
  headers: Pick<Headers, "get">,
  trustedHops = Number(process.env.JAMS_TRUSTED_PROXY_HOPS ?? 1)
): string {
  const hops = Number.isSafeInteger(trustedHops) && trustedHops > 0 ? trustedHops : 1
  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const candidate =
    forwarded.length > 0
      ? forwarded[Math.max(0, forwarded.length - hops)]
      : headers.get("x-real-ip")?.trim() ?? ""
  if (!candidate) return "unknown"

  let address = candidate
  if (address.startsWith("[")) address = address.slice(1, address.indexOf("]"))
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) address = address.split(":")[0]
  address = address.toLowerCase()

  if (address.startsWith("::ffff:") && address.includes(".")) return address.slice(7)
  if (address.includes(":")) {
    const groups = expandIpv6(address.split("%")[0])
    if (!groups) return address
    return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`
  }
  return address
}
