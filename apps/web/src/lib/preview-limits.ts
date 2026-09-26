import { sql } from "drizzle-orm"

import { analysisRuns, recordingDeletions, videos } from "@/db/schema"
import { HttpError } from "@/lib/http-error"
import {
  LimitConfigurationError,
  LimitExceededError,
  limitPolicyForOrg,
  type LimitPolicy,
} from "@/lib/limits"
import { MAX_VIDEO_SIZE_BYTES } from "@/lib/videos"
import type { OrgContext } from "@/lib/with-org"

/**
 * Usage admission: the quota checks that run inside a tenant transaction before new work is
 * written. The file keeps its preview-era name because callers import it; the limits themselves
 * now apply in every mode and are resolved by the central policy in `@/lib/limits`.
 *
 * Race-freedom: per-organization checks run under a transaction advisory lock on the
 * organization, global circuit breakers under a second, global lock. Locks are always taken in
 * that order (organization, then global) and released at commit, so concurrent requests cannot
 * both claim the last unit and cannot deadlock each other.
 */

/** Kept as aliases so existing `instanceof PreviewLimitError` checks see every quota refusal. */
export { LimitExceededError as PreviewLimitError }
export { LimitConfigurationError as PreviewLimitConfigurationError }

const GLOBAL_ANALYSIS_LOCK = "jams-global-analysis-admission"
const GLOBAL_UPLOAD_LOCK = "jams-global-upload-admission"
const GLOBAL_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000

/** Seconds a client should wait before retrying after the global circuit breaker trips. */
export const GLOBAL_ANALYSIS_RETRY_AFTER_SECONDS = 300
export const GLOBAL_UPLOAD_RETRY_AFTER_SECONDS = 3600
export const ACTIVE_ANALYSIS_RETRY_AFTER_SECONDS = 60

type ScopedDb = OrgContext["scopedDb"]

export async function lockPreviewUsage(scopedDb: ScopedDb) {
  await scopedDb.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"jams-preview-usage:" + scopedDb.orgId}, 0))`
  )
}

async function lockGlobal(scopedDb: ScopedDb, key: string) {
  await scopedDb.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

function firstNumber(result: unknown, column: string): number {
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown[] } | null)?.rows ?? []
  const row = rows[0] as Record<string, unknown> | undefined
  return Number(row?.[column] ?? 0)
}

function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024)
  if (gib >= 1) return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}-minute`
}

/**
 * Checks a new recording's declared size (and duration, when the client sends it) against the
 * per-recording limits. Not a quota: exceeding it is a request error, not a wait.
 */
export function assertRecordingWithinLimits(
  policy: LimitPolicy,
  recording: { sizeBytes: number; durationMs?: number | null }
): void {
  if (recording.sizeBytes > policy.upload.maxBytes) {
    throw new HttpError(
      413,
      `Recording is larger than the ${formatBytes(policy.upload.maxBytes)} upload limit`
    )
  }
  if (recording.durationMs != null && recording.durationMs > policy.upload.maxDurationMs) {
    throw new HttpError(
      400,
      `Recording is longer than the ${formatMinutes(policy.upload.maxDurationMs)} limit`
    )
  }
}

export async function assertUploadAdmission(
  scopedDb: ScopedDb,
  sizeBytes: number,
  options: { durationMs?: number | null; policy?: LimitPolicy } = {}
): Promise<void> {
  const policy = options.policy ?? limitPolicyForOrg(scopedDb.orgId)
  assertRecordingWithinLimits(policy, { sizeBytes, durationMs: options.durationMs })

  await lockPreviewUsage(scopedDb)

  // Every recording reserves its declared size, including incomplete and failed uploads (their
  // client-writable blobs may still exist) and legacy rows of unknown size (the file maximum).
  // A failed upload stops reserving once the watchdog has verified its blobs are deleted.
  const [usage] = await scopedDb.db
    .select({
      bytes: sql<string>`coalesce(sum(case
        when ${videos.status} = 'failed' and ${videos.uploadSourcesCleanedAt} is not null then 0
        else coalesce(${videos.sizeBytes}, ${MAX_VIDEO_SIZE_BYTES}) end), 0)`,
    })
    .from(videos)
    .where(scopedDb.orgFilter(videos))

  const [pending] = await scopedDb.db.select({
    bytes: sql<string>`coalesce(sum(${recordingDeletions.reservedBytes}) filter (where ${recordingDeletions.lastVerifiedAt} is null), 0)`,
  }).from(recordingDeletions).where(scopedDb.orgFilter(recordingDeletions))
  const usedBytes = Number(usage?.bytes ?? 0) + Number(pending?.bytes ?? 0)
  if (!Number.isSafeInteger(usedBytes) || usedBytes + sizeBytes > policy.storage.maxOrgBytes) {
    throw new LimitExceededError(
      policy.preview
        ? "Preview storage limit reached"
        : `Storage limit reached (${formatBytes(policy.storage.maxOrgBytes)} per workspace). Delete recordings you no longer need to make room.`,
      "storage"
    )
  }

  await lockGlobal(scopedDb, GLOBAL_UPLOAD_LOCK)
  const since = new Date(Date.now() - GLOBAL_UPLOAD_WINDOW_MS).toISOString()
  const globalBytes = firstNumber(
    await scopedDb.db.execute(
      sql`select jams_global_upload_bytes_since(${since}::timestamptz) as bytes`
    ),
    "bytes"
  )
  if (globalBytes + sizeBytes > policy.storage.maxGlobalBytesPerDay) {
    throw new LimitExceededError(
      "JAMS is receiving more recordings than it can take right now. Please try again later.",
      "global_upload",
      GLOBAL_UPLOAD_RETRY_AFTER_SECONDS
    )
  }
}

export async function assertAnalysisAdmission(
  scopedDb: ScopedDb,
  options: { policy?: LimitPolicy } = {}
): Promise<void> {
  const policy = options.policy ?? limitPolicyForOrg(scopedDb.orgId)
  const { analysis } = policy
  await lockPreviewUsage(scopedDb)

  const windowStart = new Date(Date.now() - analysis.windowSeconds * 1000)
  const windowStartIso = windowStart.toISOString()
  const [usage] = await scopedDb.db
    .select({
      total: sql<string>`count(*)`,
      active: sql<string>`count(*) filter (where ${analysisRuns.status} in ('queued', 'running'))`,
      inWindow: sql<string>`count(*) filter (where ${analysisRuns.createdAt} >= ${windowStartIso}::timestamptz)`,
      oldestInWindow: sql<string | null>`min(${analysisRuns.createdAt}) filter (where ${analysisRuns.createdAt} >= ${windowStartIso}::timestamptz)`,
    })
    .from(analysisRuns)
    .where(scopedDb.orgFilter(analysisRuns))

  // Runs of deleted recordings still count, so delete-and-retry cannot reset a limit. A deletion
  // inside the window counts all of its runs toward the window (conservative).
  const [deleted] = await scopedDb.db.select({
    total: sql<string>`coalesce(sum(${recordingDeletions.analysisCount}), 0)`,
    inWindow: sql<string>`coalesce(sum(${recordingDeletions.analysisCount}) filter (where ${recordingDeletions.requestedAt} >= ${windowStartIso}::timestamptz), 0)`,
  }).from(recordingDeletions).where(scopedDb.orgFilter(recordingDeletions))

  const total = Number(usage?.total ?? 0) + Number(deleted?.total ?? 0)
  const active = Number(usage?.active ?? 0)
  const inWindow = Number(usage?.inWindow ?? 0) + Number(deleted?.inWindow ?? 0)

  if (analysis.maxTotalPerOrg !== null && total >= analysis.maxTotalPerOrg) {
    throw new LimitExceededError(
      policy.preview ? "Preview analysis limit reached" : "Analysis limit reached for this workspace",
      "total_analyses"
    )
  }
  if (active >= analysis.maxActivePerOrg) {
    throw new LimitExceededError(
      policy.preview
        ? "Preview concurrent analysis limit reached"
        : `This workspace already has ${analysis.maxActivePerOrg} analyses queued or running. Try again when one finishes.`,
      "active_analyses",
      ACTIVE_ANALYSIS_RETRY_AFTER_SECONDS
    )
  }
  if (inWindow >= analysis.maxPerWindow) {
    const oldest = usage?.oldestInWindow ? new Date(usage.oldestInWindow).getTime() : Date.now()
    const retryAfter = Math.max(
      60,
      Math.ceil((oldest + analysis.windowSeconds * 1000 - Date.now()) / 1000)
    )
    throw new LimitExceededError(
      `This workspace has reached its limit of ${analysis.maxPerWindow} analyses per ${
        analysis.windowSeconds === 86_400 ? "day" : `${analysis.windowSeconds} seconds`
      }. Try again later.`,
      "analysis_window",
      retryAfter
    )
  }

  await lockGlobal(scopedDb, GLOBAL_ANALYSIS_LOCK)
  const globalActive = firstNumber(
    await scopedDb.db.execute(sql`select jams_global_active_analysis_count() as active`),
    "active"
  )
  if (globalActive >= analysis.maxGlobalActive) {
    throw new LimitExceededError(
      "JAMS is busy analyzing other recordings right now. Please try again in a few minutes.",
      "global_active_analyses",
      GLOBAL_ANALYSIS_RETRY_AFTER_SECONDS
    )
  }
}
