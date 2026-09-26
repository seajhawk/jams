// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

import { LimitExceededError, resolveLimitPolicy } from "@/lib/limits"
import {
  clientAddress,
  consumeRateLimit,
  enforceRateLimit,
  rateLimitBucket,
  resetRateLimitCacheForTests,
} from "@/lib/rate-limit"

function memoryStore() {
  const counts = new Map<string, number>()
  const increment = vi.fn(async (bucket: string, windowStart: Date) => {
    const key = `${bucket}@${windowStart.toISOString()}`
    const next = (counts.get(key) ?? 0) + 1
    counts.set(key, next)
    return next
  })
  return { increment }
}

const policy = resolveLimitPolicy({ env: { JAMS_RATE_UPLOAD_CREATE: "3/60" } })
const T0 = Date.UTC(2026, 8, 26, 12, 0, 0)

describe("fixed-window rate limiter", () => {
  beforeEach(() => resetRateLimitCacheForTests())

  it("allows up to the limit in a window, then refuses with the time left", async () => {
    const store = memoryStore()
    const results = []
    for (let i = 0; i < 4; i++) {
      results.push(await consumeRateLimit("upload_create", "user:a", { policy, store, now: T0 + 15_000 }))
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false])
    expect(results[3].retryAfterSeconds).toBe(45)
  })

  it("stops touching the store for a refused key until its window ends", async () => {
    const store = memoryStore()
    for (let i = 0; i < 4; i++) {
      await consumeRateLimit("upload_create", "user:a", { policy, store, now: T0 })
    }
    expect(store.increment).toHaveBeenCalledTimes(4)
    const cached = await consumeRateLimit("upload_create", "user:a", { policy, store, now: T0 + 1000 })
    expect(cached).toMatchObject({ allowed: false, retryAfterSeconds: 59 })
    expect(store.increment).toHaveBeenCalledTimes(4)

    // A new window starts fresh.
    const next = await consumeRateLimit("upload_create", "user:a", { policy, store, now: T0 + 60_000 })
    expect(next.allowed).toBe(true)
    expect(store.increment).toHaveBeenCalledTimes(5)
  })

  it("keeps subjects and limit names independent", async () => {
    const store = memoryStore()
    for (let i = 0; i < 3; i++) {
      await consumeRateLimit("upload_create", "user:a", { policy, store, now: T0 })
    }
    expect((await consumeRateLimit("upload_create", "user:b", { policy, store, now: T0 })).allowed).toBe(true)
    expect((await consumeRateLimit("analysis_create", "user:a", { policy, store, now: T0 })).allowed).toBe(true)
    expect(rateLimitBucket("upload_create", "user:a")).not.toBe(rateLimitBucket("analysis_create", "user:a"))
    expect(rateLimitBucket("upload_create", "user:a")).toMatch(/^[0-9a-f]{40}$/)
  })

  it("throws a 429 with Retry-After from enforceRateLimit", async () => {
    const store = memoryStore()
    for (let i = 0; i < 3; i++) await enforceRateLimit("upload_create", "user:a", { policy, store, now: T0 })
    const error = await enforceRateLimit("upload_create", "user:a", { policy, store, now: T0 }).catch((e) => e)
    expect(error).toBeInstanceOf(LimitExceededError)
    expect(error).toMatchObject({ status: 429, code: "rate", retryAfterSeconds: 60 })
  })

  it("fails open when the counter store is unavailable", async () => {
    const store = { increment: vi.fn().mockRejectedValue(new Error("relation does not exist")) }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await consumeRateLimit("upload_create", "user:a", { policy, store, now: T0 })
    expect(result.allowed).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it("does nothing when rate limiting is switched off", async () => {
    const store = memoryStore()
    const off = resolveLimitPolicy({ env: { JAMS_RATE_LIMITS_ENABLED: "false", JAMS_RATE_UPLOAD_CREATE: "1/60" } })
    for (let i = 0; i < 5; i++) {
      expect((await consumeRateLimit("upload_create", "user:a", { policy: off, store, now: T0 })).allowed).toBe(true)
    }
    expect(store.increment).not.toHaveBeenCalled()
  })
})

describe("client address for rate limiting", () => {
  const headers = (values: Record<string, string>) => new Headers(values)

  it("takes the entry the trusted ingress appended, not the client-supplied ones", () => {
    expect(clientAddress(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), 1)).toBe("203.0.113.9")
    expect(clientAddress(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.1" }), 2)).toBe("203.0.113.9")
    expect(clientAddress(headers({ "x-forwarded-for": "203.0.113.9" }), 3)).toBe("203.0.113.9")
  })

  it("normalizes ports, IPv4-mapped IPv6 and groups IPv6 clients by /64", () => {
    expect(clientAddress(headers({ "x-forwarded-for": "203.0.113.9:4312" }))).toBe("203.0.113.9")
    expect(clientAddress(headers({ "x-forwarded-for": "::ffff:203.0.113.9" }))).toBe("203.0.113.9")
    const a = clientAddress(headers({ "x-forwarded-for": "2001:db8:85a3:0001:aaaa::1" }))
    const b = clientAddress(headers({ "x-forwarded-for": "[2001:DB8:85A3:1:ffff:1:2:3]:443" }))
    expect(a).toBe("2001:db8:85a3:1::/64")
    expect(b).toBe(a)
  })

  it("falls back to a shared bucket when no address is present", () => {
    expect(clientAddress(headers({}))).toBe("unknown")
  })
})
