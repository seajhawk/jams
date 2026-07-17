import { and, eq } from "drizzle-orm"

import { db } from "@/db/client"
import {
  analysisRuns,
  effortScores,
  measures,
  segments,
  tasks,
  videos,
  weightProfiles,
} from "@/db/schema"
import { mintReadSas } from "@/lib/blob"
import { normalize, score } from "@/lib/effort-score"
import type { MeasureKind, Normalization } from "@/lib/report-contract"
import { reportPayloadSchema, type ReportPayload } from "@/lib/report-contract"
import {
  DEFAULT_WEIGHT_PROFILE_NAME,
  DEFAULT_WEIGHT_PROFILE_NORMALIZATION,
  DEFAULT_WEIGHT_PROFILE_WEIGHTS,
} from "@/lib/weight-profiles"
import { createScopedDb } from "@/lib/with-org"

export class ReportNotFoundError extends Error {
  readonly status = 404
  constructor(message = "Report not found") {
    super(message)
  }
}

export class ReportNotReadyError extends Error {
  readonly status = 404
  constructor() {
    super("Analysis is not yet complete")
  }
}

export async function getOrCreateDefaultProfile(orgId: string) {
  const scopedDb = createScopedDb(orgId)

  const [existing] = await scopedDb.db
    .select()
    .from(weightProfiles)
    .where(scopedDb.orgFilter(weightProfiles, eq(weightProfiles.isDefault, true)))
    .limit(1)

  if (existing) return existing

  const [created] = await scopedDb.db
    .insert(weightProfiles)
    .values({
      orgId,
      name: DEFAULT_WEIGHT_PROFILE_NAME,
      weights: DEFAULT_WEIGHT_PROFILE_WEIGHTS,
      normalization: DEFAULT_WEIGHT_PROFILE_NORMALIZATION,
      isDefault: true,
    })
    .returning()

  return created
}

function warningsFromRun(
  run: typeof analysisRuns.$inferSelect
): Array<{ code: string; message: string }> {
  if (run.status !== "partial") return []
  const code = run.errorCode ?? "unknown"
  return [{ code, message: errorCodeMessage(code) }]
}

function errorCodeMessage(code: string): string {
  switch (code) {
    case "no_audio":
      return "No narration audio was available for some segments."
    case "too_long":
      return "Analysis was truncated — video exceeds the 20-minute limit."
    case "corrupt_file":
      return "Part of the video file could not be read."
    case "transient":
      return "A temporary processing error occurred."
    default:
      return "Analysis completed with partial results."
  }
}

type DbMeasure = typeof measures.$inferSelect

function mapMeasure(m: DbMeasure): Record<string, unknown> | null {
  const base = {
    id: m.id,
    category: m.category,
    t_start_ms: m.tStartMs,
    confidence: m.confidence ?? 1,
    source: m.source,
    provider_id: m.providerId,
    provider_version: m.providerVersion,
  }

  const payload = (m.payload ?? {}) as Record<string, unknown>

  switch (m.kind) {
    case "utterance": {
      if (!m.valueText || m.tEndMs == null) return null
      const words = (payload.words as Array<{ w: string; t0: number; t1: number }>) ?? []
      return {
        ...base,
        kind: "utterance",
        category: "speech",
        t_end_ms: m.tEndMs,
        value_num: null,
        value_text: m.valueText,
        unit: null,
        payload: { text: m.valueText, words },
      }
    }
    case "sentiment": {
      if (m.tEndMs == null || m.valueNum == null) return null
      return {
        ...base,
        kind: "sentiment",
        category: "sentiment",
        t_end_ms: m.tEndMs,
        value_num: m.valueNum,
        value_text: null,
        unit: "score",
        payload,
      }
    }
    case "context_switch": {
      const from = (payload.from as string) ?? ""
      const to = (payload.to as string) ?? ""
      if (!from || !to) return null
      return {
        ...base,
        kind: "context_switch",
        category: "cognitive",
        t_end_ms: null,
        value_num: null,
        value_text: null,
        unit: null,
        payload: { from, to },
      }
    }
    case "spoken_word": {
      if (m.tEndMs == null || m.valueNum == null) return null
      return {
        ...base,
        kind: "spoken_word",
        category: "physical",
        t_end_ms: m.tEndMs,
        value_num: m.valueNum,
        value_text: null,
        unit: "words",
        payload,
      }
    }
    case "time_segment": {
      if (m.tEndMs == null || m.valueNum == null) return null
      const segmentId = (payload.segment_id as string) ?? ""
      return {
        ...base,
        kind: "time_segment",
        category: "time",
        t_end_ms: m.tEndMs,
        value_num: m.valueNum,
        value_text: null,
        unit: "ms",
        payload: { segment_id: segmentId },
      }
    }
    default:
      return null
  }
}

export async function assembleReportPayload(
  runId: string,
  orgId: string
): Promise<ReportPayload> {
  const scopedDb = createScopedDb(orgId)

  const [run] = await scopedDb.db
    .select()
    .from(analysisRuns)
    .where(scopedDb.orgFilter(analysisRuns, eq(analysisRuns.id, runId)))
    .limit(1)

  if (!run) throw new ReportNotFoundError()

  if (run.status !== "succeeded" && run.status !== "partial") {
    throw new ReportNotReadyError()
  }

  const [videoRow] = await db
    .select({ video: videos, taskName: tasks.name, taskId: tasks.id })
    .from(videos)
    .leftJoin(tasks, and(eq(videos.taskId, tasks.id), eq(tasks.orgId, orgId)))
    .where(and(eq(videos.id, run.videoId), eq(videos.orgId, orgId)))
    .limit(1)

  if (!videoRow) throw new ReportNotFoundError("Video not found")
  const { video, taskName, taskId } = videoRow

  if (!video.durationMs || !video.width || !video.height || video.hasAudio == null) {
    throw new ReportNotFoundError("Video metadata is incomplete")
  }

  const [segmentRows, measureRows, defaultProfile, playbackSas] = await Promise.all([
    scopedDb.db
      .select()
      .from(segments)
      .where(scopedDb.orgFilter(segments, eq(segments.runId, runId))),
    scopedDb.db
      .select()
      .from(measures)
      .where(scopedDb.orgFilter(measures, eq(measures.runId, runId))),
    getOrCreateDefaultProfile(orgId),
    mintReadSas(video.blobPath),
  ])

  const [storedScore] = await scopedDb.db
    .select()
    .from(effortScores)
    .where(
      and(
        eq(effortScores.runId, runId),
        eq(effortScores.profileId, defaultProfile.id),
        eq(effortScores.orgId, orgId)
      )
    )
    .limit(1)

  const mappedMeasures = measureRows
    .map(mapMeasure)
    .filter((m): m is Record<string, unknown> => m !== null)
    .sort((a, b) => (a.t_start_ms as number) - (b.t_start_ms as number))

  const profileWeights = defaultProfile.weights as Partial<Record<MeasureKind, number>>
  const profileNormalization = defaultProfile.normalization as Partial<
    Record<MeasureKind, Normalization>
  >

  const videoMeta = {
    id: video.id,
    title: video.title,
    duration_ms: video.durationMs,
    width: video.width,
    height: video.height,
    has_audio: video.hasAudio,
    playback_url: playbackSas.url,
  }

  let scoreBlock: ReportPayload["score"]

  if (storedScore) {
    // Breakdown is written by the worker in the same format as the contract
    const breakdown = storedScore.breakdown as ReportPayload["score"]["breakdown"]
    scoreBlock = {
      profile: {
        id: defaultProfile.id,
        name: defaultProfile.name,
        weights: profileWeights,
        normalization: profileNormalization,
      },
      components: {
        physical: storedScore.physical,
        cognitive: storedScore.cognitive,
        time: storedScore.time,
        sentiment: storedScore.sentiment,
        speech: storedScore.speech,
      },
      total: storedScore.total,
      breakdown,
    }
  } else {
    // Compute on the fly if the worker hasn't written effort_scores yet
    // (e.g. partial run or profile was created after the run completed)
    const typedMeasures = mappedMeasures as unknown as Parameters<typeof normalize>[0]
    const normalized = normalize(typedMeasures, videoMeta, profileNormalization)
    const computed = score(normalized, profileWeights)
    scoreBlock = {
      profile: {
        id: defaultProfile.id,
        name: defaultProfile.name,
        weights: profileWeights,
        normalization: profileNormalization,
      },
      components: computed.components,
      total: computed.total,
      breakdown: computed.breakdown,
    }
  }

  const payload: unknown = {
    contract_version: 1,
    run: {
      id: run.id,
      video_id: run.videoId,
      status: run.status,
      pipeline_version: run.pipelineVersion,
      finished_at: (run.completedAt ?? run.updatedAt).toISOString(),
      warnings: warningsFromRun(run),
    },
    video: videoMeta,
    task: taskId && taskName ? { id: taskId, name: taskName } : null,
    segments: segmentRows.map((s) => ({
      id: s.id,
      parent_segment_id: s.parentSegmentId ?? null,
      name: s.name,
      t_start_ms: s.tStartMs,
      t_end_ms: s.tEndMs,
      source: s.source,
    })),
    measures: mappedMeasures,
    score: scoreBlock,
  }

  return reportPayloadSchema.parse(payload)
}
