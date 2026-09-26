import { HttpError } from "@/lib/http-error"
import { MAX_VIDEO_SIZE_BYTES, videoContentTypes, type VideoContentType } from "@/lib/videos"

/**
 * The one place JAMS decides how much anyone may do.
 *
 * Every quota, circuit breaker and request rate in the app is read from a `LimitPolicy` built
 * here. Today the values come from server environment variables (documented in
 * docs/design/abuse-and-scale-hardening.md). When plans exist, a customer's entitlements are
 * passed as `entitlements` and override the per-organization values; the global circuit breakers
 * and hard ceilings are deliberately not overridable by a plan.
 *
 * Preview mode (`JAMS_PREVIEW_USER_IDS` present) keeps its existing knobs and messages:
 * `JAMS_PREVIEW_MAX_STORAGE_BYTES`, `JAMS_PREVIEW_MAX_ANALYSES` and `JAMS_PREVIEW_MAX_ACTIVE_RUNS`
 * take precedence over the general `JAMS_LIMIT_*` settings for the same limit.
 *
 * Invalid configuration fails closed: resolving the policy throws `LimitConfigurationError`
 * (503), so new work is refused rather than admitted without a limit.
 */

/** Absolute ceiling for one recording; the create schema rejects anything larger. */
export const HARD_MAX_UPLOAD_BYTES = MAX_VIDEO_SIZE_BYTES

const GIB = 1024 * 1024 * 1024

export const LIMIT_DEFAULTS = {
  uploadMaxBytes: HARD_MAX_UPLOAD_BYTES,
  uploadMaxDurationMs: 20 * 60 * 1000,
  posterMaxBytes: 5 * 1024 * 1024,
  orgStorageBytes: 10 * GIB,
  orgActiveAnalyses: 5,
  orgAnalysesPerWindow: 50,
  orgAnalysisWindowSeconds: 24 * 60 * 60,
  globalActiveAnalyses: 30,
  globalUploadBytesPerDay: 200 * GIB,
  staleUploadMinutes: 60,
  webhookMaxBodyBytes: 1024 * 1024,
  previewStorageBytes: 10 * GIB,
  previewAnalyses: 100,
  previewActiveRuns: 2,
} as const

export const rateLimitNames = [
  "upload_create",
  "analysis_create",
  "share_view_ip",
  "share_view_token",
  "webhook_ip",
] as const
export type RateLimitName = (typeof rateLimitNames)[number]

export type RateRule = { limit: number; windowSeconds: number }

const RATE_ENV: Record<RateLimitName, { env: string; fallback: RateRule }> = {
  upload_create: { env: "JAMS_RATE_UPLOAD_CREATE", fallback: { limit: 30, windowSeconds: 3600 } },
  analysis_create: { env: "JAMS_RATE_ANALYSIS_CREATE", fallback: { limit: 30, windowSeconds: 3600 } },
  share_view_ip: { env: "JAMS_RATE_SHARE_VIEW_IP", fallback: { limit: 60, windowSeconds: 600 } },
  share_view_token: { env: "JAMS_RATE_SHARE_VIEW_TOKEN", fallback: { limit: 1000, windowSeconds: 86_400 } },
  webhook_ip: { env: "JAMS_RATE_WEBHOOK_IP", fallback: { limit: 300, windowSeconds: 60 } },
}

export type LimitPolicy = {
  /** True when the invite-only preview gate is configured; selects preview knobs and wording. */
  preview: boolean
  upload: {
    maxBytes: number
    maxDurationMs: number
    maxPosterBytes: number
    contentTypes: readonly VideoContentType[]
  }
  storage: {
    /** Declared original bytes an organization may hold, including deletions not yet swept. */
    maxOrgBytes: number
    /** Circuit breaker: declared bytes of new recordings across all organizations per 24 hours. */
    maxGlobalBytesPerDay: number
  }
  analysis: {
    /** Queued plus running runs per organization, superseded ones included. */
    maxActivePerOrg: number
    maxPerWindow: number
    windowSeconds: number
    /** Lifetime runs per organization; null means no lifetime cap. */
    maxTotalPerOrg: number | null
    /** Circuit breaker: queued plus running runs across all organizations. */
    maxGlobalActive: number
  }
  cleanup: {
    staleUploadMinutes: number
  }
  requests: {
    /** Largest webhook body read before signature verification. */
    webhookMaxBodyBytes: number
  }
  rateLimitsEnabled: boolean
  rates: Record<RateLimitName, RateRule>
}

/** Per-organization values a plan may set. Anything omitted falls back to configuration. */
export type OrgEntitlements = Partial<{
  uploadMaxBytes: number
  uploadMaxDurationMs: number
  orgStorageBytes: number
  orgActiveAnalyses: number
  orgAnalysesPerWindow: number
  orgAnalysisWindowSeconds: number
  orgTotalAnalyses: number | null
}>

export type LimitCode =
  | "quota"
  | "storage"
  | "global_upload"
  | "active_analyses"
  | "analysis_window"
  | "total_analyses"
  | "global_active_analyses"
  | "rate"

export class LimitExceededError extends HttpError {
  constructor(
    message: string,
    readonly code: LimitCode = "quota",
    retryAfterSeconds?: number
  ) {
    super(429, message, retryAfterSeconds)
    this.name = "LimitExceededError"
  }
}

export class LimitConfigurationError extends HttpError {
  constructor(message: string) {
    super(503, message)
    this.name = "LimitConfigurationError"
  }
}

type Env = Record<string, string | undefined>

function positiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new LimitConfigurationError(`Invalid limit configuration: ${name}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LimitConfigurationError(`Invalid limit configuration: ${name}`)
  }
  return value
}

function optionalPositiveInteger(env: Env, name: string): number | null {
  return env[name] === undefined ? null : positiveInteger(env, name, 1)
}

function rateRule(env: Env, name: string, fallback: RateRule): RateRule {
  const raw = env[name]
  if (raw === undefined) return fallback
  const match = /^(\d+)\/(\d+)$/.exec(raw.trim())
  const limit = match ? Number(match[1]) : NaN
  const windowSeconds = match ? Number(match[2]) : NaN
  if (
    !Number.isSafeInteger(limit) || limit <= 0 ||
    !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0 || windowSeconds > 7 * 86_400
  ) {
    throw new LimitConfigurationError(`Invalid rate limit configuration: ${name}`)
  }
  return { limit, windowSeconds }
}

function booleanFlag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (raw === "true" || raw === "1") return true
  if (raw === "false" || raw === "0") return false
  throw new LimitConfigurationError(`Invalid limit configuration: ${name}`)
}

function entitled(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LimitConfigurationError(`Invalid entitlement: ${name}`)
  }
  return value
}

export function isPreviewMode(env: Env = process.env): boolean {
  return env.JAMS_PREVIEW_USER_IDS !== undefined
}

export function resolveLimitPolicy(
  options: { env?: Env; entitlements?: OrgEntitlements } = {}
): LimitPolicy {
  const env = options.env ?? process.env
  const plan = options.entitlements ?? {}
  const preview = isPreviewMode(env)

  const uploadMaxBytes = entitled(
    plan.uploadMaxBytes,
    positiveInteger(env, "JAMS_LIMIT_UPLOAD_MAX_BYTES", LIMIT_DEFAULTS.uploadMaxBytes),
    "uploadMaxBytes"
  )
  if (uploadMaxBytes > HARD_MAX_UPLOAD_BYTES) {
    throw new LimitConfigurationError("Upload size limit exceeds the 2 GiB ceiling")
  }

  const maxOrgBytes = preview
    ? positiveInteger(env, "JAMS_PREVIEW_MAX_STORAGE_BYTES", LIMIT_DEFAULTS.previewStorageBytes)
    : entitled(
        plan.orgStorageBytes,
        positiveInteger(env, "JAMS_LIMIT_ORG_STORAGE_BYTES", LIMIT_DEFAULTS.orgStorageBytes),
        "orgStorageBytes"
      )
  const maxActivePerOrg = preview
    ? positiveInteger(env, "JAMS_PREVIEW_MAX_ACTIVE_RUNS", LIMIT_DEFAULTS.previewActiveRuns)
    : entitled(
        plan.orgActiveAnalyses,
        positiveInteger(env, "JAMS_LIMIT_ORG_ACTIVE_ANALYSES", LIMIT_DEFAULTS.orgActiveAnalyses),
        "orgActiveAnalyses"
      )
  const configuredTotal = optionalPositiveInteger(env, "JAMS_LIMIT_ORG_TOTAL_ANALYSES")
  const maxTotalPerOrg = preview
    ? positiveInteger(env, "JAMS_PREVIEW_MAX_ANALYSES", LIMIT_DEFAULTS.previewAnalyses)
    : plan.orgTotalAnalyses !== undefined
      ? plan.orgTotalAnalyses === null
        ? null
        : entitled(plan.orgTotalAnalyses, 1, "orgTotalAnalyses")
      : configuredTotal

  const rates = {} as Record<RateLimitName, RateRule>
  for (const name of rateLimitNames) {
    rates[name] = rateRule(env, RATE_ENV[name].env, RATE_ENV[name].fallback)
  }

  return {
    preview,
    upload: {
      maxBytes: uploadMaxBytes,
      maxDurationMs: entitled(
        plan.uploadMaxDurationMs,
        positiveInteger(env, "JAMS_LIMIT_UPLOAD_MAX_DURATION_MS", LIMIT_DEFAULTS.uploadMaxDurationMs),
        "uploadMaxDurationMs"
      ),
      maxPosterBytes: positiveInteger(env, "JAMS_LIMIT_POSTER_MAX_BYTES", LIMIT_DEFAULTS.posterMaxBytes),
      contentTypes: videoContentTypes,
    },
    storage: {
      maxOrgBytes,
      maxGlobalBytesPerDay: positiveInteger(
        env,
        "JAMS_LIMIT_GLOBAL_UPLOAD_BYTES_PER_DAY",
        LIMIT_DEFAULTS.globalUploadBytesPerDay
      ),
    },
    analysis: {
      maxActivePerOrg,
      maxPerWindow: entitled(
        plan.orgAnalysesPerWindow,
        positiveInteger(env, "JAMS_LIMIT_ORG_ANALYSES_PER_WINDOW", LIMIT_DEFAULTS.orgAnalysesPerWindow),
        "orgAnalysesPerWindow"
      ),
      windowSeconds: entitled(
        plan.orgAnalysisWindowSeconds,
        positiveInteger(
          env,
          "JAMS_LIMIT_ORG_ANALYSIS_WINDOW_SECONDS",
          LIMIT_DEFAULTS.orgAnalysisWindowSeconds
        ),
        "orgAnalysisWindowSeconds"
      ),
      maxTotalPerOrg,
      maxGlobalActive: positiveInteger(
        env,
        "JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES",
        LIMIT_DEFAULTS.globalActiveAnalyses
      ),
    },
    cleanup: {
      staleUploadMinutes: positiveInteger(
        env,
        "JAMS_LIMIT_STALE_UPLOAD_MINUTES",
        LIMIT_DEFAULTS.staleUploadMinutes
      ),
    },
    requests: {
      webhookMaxBodyBytes: positiveInteger(
        env,
        "JAMS_WEBHOOK_MAX_BODY_BYTES",
        LIMIT_DEFAULTS.webhookMaxBodyBytes
      ),
    },
    rateLimitsEnabled: booleanFlag(env, "JAMS_RATE_LIMITS_ENABLED", true),
    rates,
  }
}

/**
 * The policy for one organization. The seam for plans: look up the organization's entitlements
 * here (from the billing mirror) and pass them to `resolveLimitPolicy`. Until then every
 * organization gets the configured values.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the plan lookup will use it
export function limitPolicyForOrg(_orgId: string): LimitPolicy {
  return resolveLimitPolicy()
}

/** The subset of the policy the browser needs to reject a recording before uploading it. */
export type ClientUploadLimits = {
  max_bytes: number
  max_duration_ms: number
  content_types: readonly string[]
}

export function clientUploadLimits(policy: LimitPolicy): ClientUploadLimits {
  return {
    max_bytes: policy.upload.maxBytes,
    max_duration_ms: policy.upload.maxDurationMs,
    content_types: policy.upload.contentTypes,
  }
}
