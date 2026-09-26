import { and, inArray, isNull } from "drizzle-orm"

import { measures, segments, videos } from "@/db/schema"
import { type JourneySession, loadJourneySessions } from "@/lib/hierarchy"
import { computeHotspots, rankHotspots, type HotspotSession } from "@/lib/hotspots"
import { splitByReferenceFingerprint } from "@/lib/stats"
import { alignSteps } from "@/lib/steps"
import type { OrgContext } from "@/lib/with-org"

const HOTSPOT_KINDS = ["sentiment", "context_switch", "utterance"]

/**
 * Steps view of one journey: each comparable session's step alignment and the per-step hotspots.
 * Sessions are filtered by cohort/variant first, then to the newest scoring definition (U2 rule).
 */
export async function loadJourneySteps(
  orgId: string,
  scopedDb: OrgContext["scopedDb"],
  journey: { id: string; steps: string[] },
  filters: { cohort?: string | null; variant?: string | null }
) {
  const all = (await loadJourneySessions(orgId, scopedDb, [journey.id])).get(journey.id) ?? []
  const filtered = all.filter(
    (session: JourneySession) =>
      (!filters.cohort || session.participant?.cohorts.includes(filters.cohort)) &&
      (!filters.variant || session.variant?.name === filters.variant)
  )
  const { included, excluded } = splitByReferenceFingerprint(filtered)
  const runIds = included.map((session) => session.analysis!.id)

  // Suggestions come from every session's latest analysis that found segments, scored or not, so a
  // journey with only partial analyses can still start from the names JAMS found.
  const suggestionRunIds = all.flatMap((session) => (session.analysis ? [session.analysis.id] : []))
  const suggestionRows = suggestionRunIds.length
    ? await scopedDb.db
        .select({ name: segments.name })
        .from(segments)
        .where(
          scopedDb.orgFilter(
            segments,
            and(inArray(segments.runId, suggestionRunIds), isNull(segments.parentSegmentId))
          )
        )
    : []
  const counts = new Map<string, number>()
  for (const row of suggestionRows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
  const suggestions =
    journey.steps.length === 0
      ? [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([name]) => name)
      : []

  if (runIds.length === 0) {
    return { steps: journey.steps, sessions: [], hotspots: [], ranked: [], estimated: false, excluded, suggestions }
  }

  const [videoRows, segmentRows, measureRows] = await Promise.all([
    scopedDb.db
      .select({ id: videos.id, durationMs: videos.durationMs, boundaries: videos.stepBoundariesMs })
      .from(videos)
      .where(scopedDb.orgFilter(videos, inArray(videos.id, included.map((s) => s.video_id)))),
    scopedDb.db
      .select({
        runId: segments.runId,
        name: segments.name,
        tStartMs: segments.tStartMs,
        tEndMs: segments.tEndMs,
      })
      .from(segments)
      .where(
        scopedDb.orgFilter(segments, and(inArray(segments.runId, runIds), isNull(segments.parentSegmentId)))
      ),
    scopedDb.db
      .select({
        id: measures.id,
        runId: measures.runId,
        kind: measures.kind,
        tStartMs: measures.tStartMs,
        valueNum: measures.valueNum,
        valueText: measures.valueText,
        payload: measures.payload,
      })
      .from(measures)
      .where(scopedDb.orgFilter(measures, and(inArray(measures.runId, runIds), inArray(measures.kind, HOTSPOT_KINDS)))),
  ])

  const videoById = new Map(videoRows.map((row) => [row.id, row]))
  const utteranceText = new Map(
    measureRows.filter((m) => m.kind === "utterance").map((m) => [m.id, m.valueText])
  )

  const hotspotSessions: HotspotSession[] = included.map((session) => {
    const runId = session.analysis!.id
    const video = videoById.get(session.video_id)
    const runSegments = segmentRows
      .filter((row) => row.runId === runId)
      .map((row) => ({ name: row.name, t_start_ms: row.tStartMs, t_end_ms: row.tEndMs }))
    const durationMs =
      video?.durationMs ?? Math.max(0, ...runSegments.map((segment) => segment.t_end_ms))
    return {
      video_id: session.video_id,
      run_id: runId,
      title: session.title,
      participant_label: session.participant?.label ?? null,
      alignment: alignSteps({
        steps: journey.steps,
        segments: runSegments,
        durationMs,
        manualBoundariesMs: video?.boundaries ?? null,
      }),
      measures: measureRows
        .filter((m) => m.runId === runId && m.kind !== "utterance")
        .map((m) => {
          const linked = (m.payload as { utterance_measure_id?: unknown })?.utterance_measure_id
          return {
            kind: m.kind,
            t_start_ms: m.tStartMs,
            value_num: m.valueNum,
            text: typeof linked === "string" ? (utteranceText.get(linked) ?? null) : null,
          }
        }),
    }
  })

  const hotspots = computeHotspots(journey.steps, hotspotSessions)

  return {
    steps: journey.steps,
    sessions: hotspotSessions.map((session) => ({
      video_id: session.video_id,
      run_id: session.run_id,
      title: session.title,
      source: session.alignment.source,
      spans: session.alignment.steps,
    })),
    hotspots,
    ranked: rankHotspots(hotspots).map((hotspot) => hotspot.index),
    estimated: hotspotSessions.some((session) => session.alignment.source === "even"),
    excluded,
    suggestions,
  }
}
