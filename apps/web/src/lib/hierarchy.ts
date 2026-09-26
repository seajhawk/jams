import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { z } from "zod"

import {
  analysisRuns,
  effortScores,
  goals,
  participants,
  projects,
  tasks,
  variants,
  videos,
} from "@/db/schema"
import { HttpError } from "@/lib/api"
import { getOrCreateDefaultProfileInScope } from "@/lib/report-assembly"
import { splitByReferenceFingerprint, summarizeTotals } from "@/lib/stats"
import type { OrgContext } from "@/lib/with-org"

export { summarizeTotals }

type ScopedDb = OrgContext["scopedDb"]

const name = z.string().trim().min(1).max(160)
const optionalText = z.string().trim().min(1).max(2_000).optional()
const nullableText = z.string().trim().max(2_000).nullable().optional()

export const createProjectSchema = z.object({ name, description: optionalText })
export const updateProjectSchema = z
  .object({ name: name.optional(), description: nullableText })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update")

export const createGoalSchema = z.object({
  project_id: z.string().uuid(),
  name,
  description: optionalText,
  success_criterion: optionalText,
})
export const updateGoalSchema = z
  .object({
    name: name.optional(),
    description: nullableText,
    success_criterion: nullableText,
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update")

const steps = z.array(z.string().trim().min(1).max(160)).max(50)

export const createJourneySchema = z.object({
  name,
  description: optionalText,
  goal_id: z.string().uuid().optional(),
  steps: steps.optional(),
})
export const updateJourneySchema = z
  .object({
    name: name.optional(),
    description: nullableText,
    goal_id: z.string().uuid().nullable().optional(),
    steps: steps.optional(),
    status: z.enum(["active", "retired"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update")

const cohorts = z
  .array(z.string().trim().min(1).max(60).toLowerCase())
  .max(20)
  .transform((values) => [...new Set(values)])

export const createParticipantSchema = z.object({
  label: z.string().trim().min(1).max(120),
  cohorts: cohorts.optional(),
  notes: optionalText,
})
export const updateParticipantSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    cohorts: cohorts.optional(),
    notes: nullableText,
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update")

export const createVariantSchema = z.object({
  task_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  build: z.string().trim().min(1).max(120).optional(),
})

/** 404-style guard: the row must exist in the caller's workspace, or the id is treated as unknown. */
export async function assertInOrg(
  scopedDb: ScopedDb,
  table: typeof projects | typeof goals | typeof tasks | typeof participants | typeof variants,
  id: string,
  label: string
) {
  const [row] = await scopedDb.db
    .select({ id: table.id })
    .from(table)
    .where(scopedDb.orgFilter(table, eq(table.id, id)))
    .limit(1)
  if (!row) throw new HttpError(400, `${label} not found`)
}

export type JourneySession = {
  video_id: string
  title: string
  created_at: string
  participant: { id: string; label: string; cohorts: string[] } | null
  variant: { id: string; name: string; build: string | null } | null
  analysis: {
    id: string
    status: string
    total: number | null
    fingerprint_hash: string | null
    created_at: string
  } | null
}

/**
 * Sessions of the given journeys with their latest analysis and its default-profile total.
 * "Latest" is the run nothing has superseded, matching the Library.
 */
export async function loadJourneySessions(
  orgId: string,
  scopedDb: ScopedDb,
  journeyIds: string[]
): Promise<Map<string, JourneySession[]>> {
  const byJourney = new Map<string, JourneySession[]>()
  if (journeyIds.length === 0) return byJourney

  const rows = await scopedDb.db
    .select({ video: videos, participant: participants, variant: variants })
    .from(videos)
    .leftJoin(
      participants,
      and(eq(participants.id, videos.participantId), eq(participants.orgId, orgId))
    )
    .leftJoin(variants, and(eq(variants.id, videos.variantId), eq(variants.orgId, orgId)))
    .where(
      scopedDb.orgFilter(
        videos,
        and(inArray(videos.taskId, journeyIds), isNull(videos.archivedAt))
      )
    )
    .orderBy(desc(videos.createdAt))

  const videoIds = rows.map((row) => row.video.id)
  const runs = videoIds.length
    ? await scopedDb.db
        .select({
          id: analysisRuns.id,
          videoId: analysisRuns.videoId,
          status: analysisRuns.status,
          fingerprintHash: analysisRuns.fingerprintHash,
          createdAt: analysisRuns.createdAt,
        })
        .from(analysisRuns)
        .where(
          scopedDb.orgFilter(
            analysisRuns,
            and(inArray(analysisRuns.videoId, videoIds), isNull(analysisRuns.supersededBy))
          )
        )
    : []
  const runByVideo = new Map(runs.map((run) => [run.videoId, run]))

  const scoredRunIds = runs
    .filter((run) => run.status === "succeeded" || run.status === "partial")
    .map((run) => run.id)
  const totals = new Map<string, number>()
  if (scoredRunIds.length) {
    const profile = await getOrCreateDefaultProfileInScope(orgId, scopedDb)
    const scoreRows = await scopedDb.db
      .select({ runId: effortScores.runId, total: effortScores.total })
      .from(effortScores)
      .where(
        scopedDb.orgFilter(
          effortScores,
          and(inArray(effortScores.runId, scoredRunIds), eq(effortScores.profileId, profile.id))
        )
      )
    for (const row of scoreRows) totals.set(row.runId, row.total)
  }

  for (const row of rows) {
    const run = runByVideo.get(row.video.id)
    const session: JourneySession = {
      video_id: row.video.id,
      title: row.video.title,
      created_at: row.video.createdAt.toISOString(),
      participant: row.participant
        ? { id: row.participant.id, label: row.participant.label, cohorts: row.participant.cohorts }
        : null,
      variant: row.variant
        ? { id: row.variant.id, name: row.variant.name, build: row.variant.build }
        : null,
      analysis: run
        ? {
            id: run.id,
            status: run.status,
            total: totals.get(run.id) ?? null,
            fingerprint_hash: run.fingerprintHash,
            created_at: run.createdAt.toISOString(),
          }
        : null,
    }
    const journeyId = row.video.taskId as string
    byJourney.set(journeyId, [...(byJourney.get(journeyId) ?? []), session])
  }
  return byJourney
}

/**
 * The scoring definition a journey's numbers use: the fingerprint of the newest scored analysis
 * that recorded one. Analyses without a fingerprint (scored before fingerprints existed) are never
 * treated as comparable, even with each other: their models and score formula are unknown.
 */
export function referenceFingerprint(sessions: JourneySession[]): string | null {
  // One rule for the whole app: see splitByReferenceFingerprint.
  return splitByReferenceFingerprint(sessions).reference
}

/** True when a session's score is on the given reference definition and may be aggregated. */
export function isComparable(session: JourneySession, reference: string | null) {
  return (
    reference !== null &&
    session.analysis?.total != null &&
    session.analysis.fingerprint_hash === reference
  )
}

/**
 * Stats over sessions scored with the reference definition only. Sessions scored any other way
 * are excluded and counted, never averaged in (docs/design/customer-journeys-ux.md §3.2).
 */
export function journeyStats(sessions: JourneySession[]) {
  const scored = sessions.filter((session) => session.analysis?.total != null)
  const reference = referenceFingerprint(sessions)
  const comparable = scored.filter((session) => isComparable(session, reference))
  const fingerprints = new Set(
    scored.map((session) => session.analysis?.fingerprint_hash ?? "unrecorded")
  )
  return {
    session_count: sessions.length,
    ...summarizeTotals(comparable.map((session) => session.analysis!.total as number)),
    reference_fingerprint: reference,
    excluded: scored.length - comparable.length,
    fingerprint_count: fingerprints.size,
    mixed_definitions: scored.length > comparable.length,
  }
}
