import { sql } from "drizzle-orm"

import { analysisRuns, recordingDeletions, videos } from "@/db/schema"
import { HttpError } from "@/lib/api"
import { MAX_VIDEO_SIZE_BYTES } from "@/lib/videos"
import type { OrgContext } from "@/lib/with-org"

const DEFAULT_MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024
const DEFAULT_MAX_ANALYSES = 100
const DEFAULT_MAX_ACTIVE_RUNS = 2

export class PreviewLimitError extends HttpError {
  constructor(message: string) {
    super(429, message)
    this.name = "PreviewLimitError"
  }
}

export class PreviewLimitConfigurationError extends HttpError {
  constructor(message: string) {
    super(503, message)
    this.name = "PreviewLimitConfigurationError"
  }
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback

  if (!/^\d+$/.test(raw)) {
    throw new PreviewLimitConfigurationError(`Invalid preview limit: ${name}`)
  }

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PreviewLimitConfigurationError(`Invalid preview limit: ${name}`)
  }
  return value
}

function configuredLimits() {
  return {
    maxStorageBytes: positiveInteger(
      "JAMS_PREVIEW_MAX_STORAGE_BYTES",
      DEFAULT_MAX_STORAGE_BYTES
    ),
    maxAnalyses: positiveInteger("JAMS_PREVIEW_MAX_ANALYSES", DEFAULT_MAX_ANALYSES),
    maxActiveRuns: positiveInteger("JAMS_PREVIEW_MAX_ACTIVE_RUNS", DEFAULT_MAX_ACTIVE_RUNS),
  }
}

export async function lockPreviewUsage(scopedDb: OrgContext["scopedDb"]) {
  await scopedDb.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"jams-preview-usage:" + scopedDb.orgId}, 0))`
  )
}

export async function assertUploadAdmission(
  scopedDb: OrgContext["scopedDb"],
  sizeBytes: number
): Promise<void> {
  if (process.env.JAMS_PREVIEW_USER_IDS === undefined) return

  const { maxStorageBytes } = configuredLimits()
  await lockPreviewUsage(scopedDb)

  const [usage] = await scopedDb.db
    .select({
      bytes: sql<string>`coalesce(sum(coalesce(${videos.sizeBytes}, ${MAX_VIDEO_SIZE_BYTES})), 0)`,
    })
    .from(videos)
    .where(scopedDb.orgFilter(videos))

  const [pending] = await scopedDb.db.select({
    bytes: sql<string>`coalesce(sum(${recordingDeletions.reservedBytes}) filter (where ${recordingDeletions.lastVerifiedAt} is null), 0)`,
  }).from(recordingDeletions).where(scopedDb.orgFilter(recordingDeletions))
  const usedBytes = Number(usage?.bytes ?? 0) + Number(pending?.bytes ?? 0)
  if (!Number.isSafeInteger(usedBytes) || usedBytes + sizeBytes > maxStorageBytes) {
    throw new PreviewLimitError("Preview storage limit reached")
  }
}

export async function assertAnalysisAdmission(
  scopedDb: OrgContext["scopedDb"]
): Promise<void> {
  if (process.env.JAMS_PREVIEW_USER_IDS === undefined) return

  const { maxAnalyses, maxActiveRuns } = configuredLimits()
  await lockPreviewUsage(scopedDb)

  const [usage] = await scopedDb.db
    .select({
      total: sql<string>`count(*)`,
      active: sql<string>`count(*) filter (where ${analysisRuns.status} in ('queued', 'running'))`,
    })
    .from(analysisRuns)
    .where(scopedDb.orgFilter(analysisRuns))

  const [deleted] = await scopedDb.db.select({
    total: sql<string>`coalesce(sum(${recordingDeletions.analysisCount}), 0)`,
  }).from(recordingDeletions).where(scopedDb.orgFilter(recordingDeletions))
  const total = Number(usage?.total ?? 0) + Number(deleted?.total ?? 0)
  const active = Number(usage?.active ?? 0)
  if (total >= maxAnalyses) {
    throw new PreviewLimitError("Preview analysis limit reached")
  }
  if (active >= maxActiveRuns) {
    throw new PreviewLimitError("Preview concurrent analysis limit reached")
  }
}
