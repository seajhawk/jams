// @vitest-environment node
import { describe, expect, it } from "vitest"

import { stableJson } from "@/lib/analysis-idempotency"
import {
  LIMIT_DEFAULTS,
  LimitConfigurationError,
  clientUploadLimits,
  resolveLimitPolicy,
} from "@/lib/limits"

const GIB = 1024 * 1024 * 1024

describe("central limit policy", () => {
  it("applies the documented defaults outside preview", () => {
    const policy = resolveLimitPolicy({ env: {} })
    expect(policy.preview).toBe(false)
    expect(policy.upload).toMatchObject({
      maxBytes: 2 * GIB,
      maxDurationMs: 20 * 60 * 1000,
      maxPosterBytes: 5 * 1024 * 1024,
    })
    expect(policy.storage).toEqual({ maxOrgBytes: 10 * GIB, maxGlobalBytesPerDay: 200 * GIB })
    expect(policy.analysis).toEqual({
      maxActivePerOrg: 5,
      maxPerWindow: 50,
      windowSeconds: 86_400,
      maxTotalPerOrg: null,
      maxGlobalActive: 30,
    })
    expect(policy.rates.upload_create).toEqual({ limit: 30, windowSeconds: 3600 })
    expect(policy.rates.share_view_token).toEqual({ limit: 1000, windowSeconds: 86_400 })
    expect(policy.rateLimitsEnabled).toBe(true)
  })

  it("keeps the preview knobs and defaults when the preview gate is configured", () => {
    const defaults = resolveLimitPolicy({ env: { JAMS_PREVIEW_USER_IDS: "user_a" } })
    expect(defaults.preview).toBe(true)
    expect(defaults.storage.maxOrgBytes).toBe(LIMIT_DEFAULTS.previewStorageBytes)
    expect(defaults.analysis.maxActivePerOrg).toBe(2)
    expect(defaults.analysis.maxTotalPerOrg).toBe(100)

    const configured = resolveLimitPolicy({
      env: {
        JAMS_PREVIEW_USER_IDS: "",
        JAMS_PREVIEW_MAX_STORAGE_BYTES: "100",
        JAMS_PREVIEW_MAX_ANALYSES: "3",
        JAMS_PREVIEW_MAX_ACTIVE_RUNS: "1",
        // General knobs for the same limits do not override preview ones.
        JAMS_LIMIT_ORG_STORAGE_BYTES: "999",
        JAMS_LIMIT_ORG_ACTIVE_ANALYSES: "9",
      },
    })
    expect(configured.storage.maxOrgBytes).toBe(100)
    expect(configured.analysis.maxTotalPerOrg).toBe(3)
    expect(configured.analysis.maxActivePerOrg).toBe(1)
  })

  it("reads every general knob from the environment", () => {
    const policy = resolveLimitPolicy({
      env: {
        JAMS_LIMIT_UPLOAD_MAX_BYTES: "1000",
        JAMS_LIMIT_UPLOAD_MAX_DURATION_MS: "60000",
        JAMS_LIMIT_POSTER_MAX_BYTES: "10",
        JAMS_LIMIT_ORG_STORAGE_BYTES: "5000",
        JAMS_LIMIT_ORG_ACTIVE_ANALYSES: "1",
        JAMS_LIMIT_ORG_ANALYSES_PER_WINDOW: "2",
        JAMS_LIMIT_ORG_ANALYSIS_WINDOW_SECONDS: "3600",
        JAMS_LIMIT_ORG_TOTAL_ANALYSES: "7",
        JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES: "4",
        JAMS_LIMIT_GLOBAL_UPLOAD_BYTES_PER_DAY: "123",
        JAMS_LIMIT_STALE_UPLOAD_MINUTES: "30",
        JAMS_RATE_WEBHOOK_IP: "5/10",
        JAMS_RATE_LIMITS_ENABLED: "false",
      },
    })
    expect(policy.upload.maxBytes).toBe(1000)
    expect(policy.upload.maxDurationMs).toBe(60_000)
    expect(policy.upload.maxPosterBytes).toBe(10)
    expect(policy.storage).toEqual({ maxOrgBytes: 5000, maxGlobalBytesPerDay: 123 })
    expect(policy.analysis).toEqual({
      maxActivePerOrg: 1,
      maxPerWindow: 2,
      windowSeconds: 3600,
      maxTotalPerOrg: 7,
      maxGlobalActive: 4,
    })
    expect(policy.cleanup.staleUploadMinutes).toBe(30)
    expect(policy.rates.webhook_ip).toEqual({ limit: 5, windowSeconds: 10 })
    expect(policy.rateLimitsEnabled).toBe(false)
  })

  it.each([
    ["JAMS_LIMIT_ORG_ACTIVE_ANALYSES", "0"],
    ["JAMS_LIMIT_ORG_ACTIVE_ANALYSES", "-1"],
    ["JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES", "lots"],
    ["JAMS_LIMIT_UPLOAD_MAX_BYTES", String(3 * GIB)],
    ["JAMS_RATE_UPLOAD_CREATE", "30"],
    ["JAMS_RATE_UPLOAD_CREATE", "0/60"],
    ["JAMS_RATE_UPLOAD_CREATE", "10/9999999"],
    ["JAMS_RATE_LIMITS_ENABLED", "maybe"],
    ["JAMS_PREVIEW_MAX_ANALYSES", "1.5"],
  ])("fails closed with 503 on %s=%s", (name, value) => {
    const env: Record<string, string> = { [name]: value }
    if (name.startsWith("JAMS_PREVIEW_")) env.JAMS_PREVIEW_USER_IDS = "user_a"
    expect(() => resolveLimitPolicy({ env })).toThrow(LimitConfigurationError)
    try {
      resolveLimitPolicy({ env })
    } catch (error) {
      expect((error as LimitConfigurationError).status).toBe(503)
    }
  })

  it("lets plan entitlements override per-organization limits but not global breakers", () => {
    const policy = resolveLimitPolicy({
      env: { JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES: "8" },
      entitlements: {
        orgAnalysesPerWindow: 1,
        orgStorageBytes: 500 * 1024 * 1024,
        uploadMaxBytes: 200 * 1024 * 1024,
        orgTotalAnalyses: null,
      },
    })
    expect(policy.analysis.maxPerWindow).toBe(1)
    expect(policy.storage.maxOrgBytes).toBe(500 * 1024 * 1024)
    expect(policy.upload.maxBytes).toBe(200 * 1024 * 1024)
    expect(policy.analysis.maxTotalPerOrg).toBeNull()
    expect(policy.analysis.maxGlobalActive).toBe(8)

    expect(() =>
      resolveLimitPolicy({ env: {}, entitlements: { uploadMaxBytes: 3 * GIB } })
    ).toThrow(LimitConfigurationError)
  })

  it("exposes only upload limits to the browser", () => {
    expect(clientUploadLimits(resolveLimitPolicy({ env: {} }))).toEqual({
      max_bytes: 2 * GIB,
      max_duration_ms: 1_200_000,
      content_types: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"],
    })
  })
})

describe("analysis config comparison for double-submit detection", () => {
  it("ignores object key order, which jsonb does not preserve", () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 })
    )
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }))
    expect(stableJson(undefined)).toBe("null")
  })
})
