import { z } from "zod"

import { analysisRuns } from "@/db/schema"

export const analysisStatuses = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
] as const

export const analysisErrorCodes = [
  "no_audio",
  "too_long",
  "corrupt_file",
  "transient",
  "unknown",
] as const

export type AnalysisStatus = (typeof analysisStatuses)[number]
export type AnalysisErrorCode = (typeof analysisErrorCodes)[number]
export type AnalysisRunRow = typeof analysisRuns.$inferSelect

export const createAnalysisSchema = z.object({
  video_id: z.string().uuid(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export function serializeAnalysisRun(run: AnalysisRunRow) {
  return {
    id: run.id,
    video_id: run.videoId,
    pipeline_version: run.pipelineVersion,
    status: run.status,
    stage: run.stage,
    progress_pct: run.progressPct,
    stage_detail: run.stageDetail,
    error_code: run.errorCode,
    attempt: run.attempt,
    superseded_by: run.supersededBy,
    timestamps: {
      created_at: run.createdAt.toISOString(),
      updated_at: run.updatedAt.toISOString(),
      started_at: run.startedAt?.toISOString() ?? null,
      completed_at: run.completedAt?.toISOString() ?? null,
    },
  }
}
