import type { JourneySession } from "@/lib/hierarchy"
import { compareGroups, splitByReferenceFingerprint, summarizeTotals, type GroupComparison } from "@/lib/stats"

export type CompareBy = "variant" | "cohort"

const totalOf = (session: JourneySession) => session.analysis!.total as number

function inGroup(session: JourneySession, by: CompareBy, name: string) {
  return by === "variant"
    ? session.variant?.name === name
    : (session.participant?.cohorts ?? []).includes(name)
}

/** Two groups of one journey's sessions (by variant or cohort), on one scoring definition. */
export function compareWithinJourney(
  sessions: JourneySession[],
  by: CompareBy,
  a: string,
  b: string
) {
  const { reference, included, excluded } = splitByReferenceFingerprint(sessions)
  const groupA = included.filter((session) => inGroup(session, by, a))
  const groupB = included.filter((session) => inGroup(session, by, b))
  return {
    by,
    reference_fingerprint: reference,
    excluded,
    comparison: compareGroups(
      { name: a, values: groupA.map(totalOf) },
      { name: b, values: groupB.map(totalOf) }
    ),
    points: {
      a: groupA.map((s) => ({ video_id: s.video_id, title: s.title, total: totalOf(s) })),
      b: groupB.map((s) => ({ video_id: s.video_id, title: s.title, total: totalOf(s) })),
    },
  }
}

export interface GoalJourneyResult {
  id: string
  name: string
  stats: ReturnType<typeof summarizeTotals>
  totals: number[]
  vs_easiest: GroupComparison | null
}

/**
 * Journeys of one goal, easiest first, each compared with the easiest. Every journey is measured
 * on the same scoring definition (the newest across the goal).
 */
export function compareJourneysOfGoal(journeys: { id: string; name: string; sessions: JourneySession[] }[]) {
  const all = journeys.flatMap((journey) => journey.sessions)
  const { reference, included, excluded } = splitByReferenceFingerprint(all)
  const kept = new Set(included.map((session) => session.video_id))

  const measured = journeys.map((journey) => {
    const totals = journey.sessions.filter((s) => kept.has(s.video_id)).map(totalOf)
    return { id: journey.id, name: journey.name, totals, stats: summarizeTotals(totals) }
  })
  measured.sort((x, y) => {
    if (x.stats.median === null) return 1
    if (y.stats.median === null) return -1
    return x.stats.median - y.stats.median || y.stats.n - x.stats.n
  })
  const easiest = measured.find((journey) => journey.stats.n > 0)

  const results: GoalJourneyResult[] = measured.map((journey) => ({
    ...journey,
    vs_easiest:
      easiest && journey !== easiest && journey.stats.n > 0
        ? compareGroups(
            { name: easiest.name, values: easiest.totals },
            { name: journey.name, values: journey.totals }
          )
        : null,
  }))
  return { reference_fingerprint: reference, excluded, easiest_id: easiest?.id ?? null, journeys: results }
}

/**
 * Sessions to re-analyze so a journey sits on one scoring definition: never analyzed, or last
 * scored under another definition. Sessions with an analysis in flight are left alone.
 */
export function outdatedSessions(sessions: JourneySession[]) {
  const { reference } = splitByReferenceFingerprint(sessions)
  return sessions.filter((session) => {
    const analysis = session.analysis
    if (!analysis) return true
    if (analysis.status === "queued" || analysis.status === "running") return false
    if (analysis.status === "failed") return true
    // With no recorded reference, every scored session is on an unknown definition: re-analyze it.
    return reference === null || analysis.fingerprint_hash !== reference
  })
}
