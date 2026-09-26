import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"

import { goals, tasks } from "@/db/schema"
import { compareJourneysOfGoal, compareWithinJourney } from "@/lib/comparisons"
import { loadJourneySessions } from "@/lib/hierarchy"
import { loadJourneySteps } from "@/lib/journey-steps"
import type { OrgContext } from "@/lib/with-org"

type ScopedDb = OrgContext["scopedDb"]

export const findingSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comparison"),
    journey_id: z.string().uuid(),
    by: z.enum(["variant", "cohort"]),
    a: z.string().trim().min(1).max(120),
    b: z.string().trim().min(1).max(120),
  }),
  z.object({
    kind: z.literal("hotspot"),
    journey_id: z.string().uuid(),
    step_index: z.number().int().min(0).max(49),
    cohort: z.string().trim().min(1).max(60).optional(),
    variant: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({ kind: z.literal("leaderboard"), goal_id: z.string().uuid() }),
])
export type FindingSource = z.infer<typeof findingSourceSchema>

export const createFindingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().min(1).max(4_000).optional(),
  source: findingSourceSchema,
})

export const updateFindingSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional(), note: z.string().trim().max(4_000).nullable().optional() })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update")

export interface FindingSnapshot {
  label: string
  headline: string
  /** What must stay the same for the finding to still hold. */
  key: string
  reference_fingerprint: string | null
  details: Record<string, unknown>
  computed_at: string
}

async function journeyRow(scopedDb: ScopedDb, id: string) {
  const [row] = await scopedDb.db
    .select({ id: tasks.id, name: tasks.name, steps: tasks.steps })
    .from(tasks)
    .where(scopedDb.orgFilter(tasks, eq(tasks.id, id)))
    .limit(1)
  return row
}

/** Recompute a finding's snapshot from its source, server-side. Null when the source is gone. */
export async function buildSnapshot(
  orgId: string,
  scopedDb: ScopedDb,
  source: FindingSource
): Promise<FindingSnapshot | null> {
  const computed_at = new Date().toISOString()

  if (source.kind === "comparison") {
    const journey = await journeyRow(scopedDb, source.journey_id)
    if (!journey) return null
    const sessions = (await loadJourneySessions(orgId, scopedDb, [journey.id])).get(journey.id) ?? []
    const result = compareWithinJourney(sessions, source.by, source.a, source.b)
    const { comparison } = result
    return {
      label: `${journey.name}: ${source.a} vs ${source.b}`,
      headline: comparison.verdict.text,
      key: `${comparison.verdict.kind}`,
      reference_fingerprint: result.reference_fingerprint,
      details: {
        a: { name: comparison.a.name, n: comparison.a.n, median: comparison.a.median },
        b: { name: comparison.b.name, n: comparison.b.n, median: comparison.b.median },
        difference: comparison.difference,
        low: comparison.low,
        high: comparison.high,
        excluded: result.excluded,
      },
      computed_at,
    }
  }

  if (source.kind === "hotspot") {
    const journey = await journeyRow(scopedDb, source.journey_id)
    if (!journey || source.step_index >= journey.steps.length) return null
    const view = await loadJourneySteps(orgId, scopedDb, journey, {
      cohort: source.cohort ?? null,
      variant: source.variant ?? null,
    })
    const hotspot = view.hotspots[source.step_index]
    if (!hotspot) return null
    const worstStep = view.ranked[0] === source.step_index
    return {
      label: `${journey.name}: ${hotspot.step}`,
      headline: `${hotspot.step}: frustration in ${hotspot.frustrated_sessions} of ${hotspot.sessions} sessions${
        hotspot.mean_duration_ms !== null ? `, ${Math.round(hotspot.mean_duration_ms / 1000)} s on average` : ""
      }.`,
      // The claim is "people struggle at this step": it holds while that step still shows
      // frustration, whether or not it is currently the worst-ranked step.
      key: hotspot.frustrated_sessions > 0 ? "struggle" : "no-struggle",
      reference_fingerprint: view.reference_fingerprint,
      details: {
        step: hotspot.step,
        frustrated_sessions: hotspot.frustrated_sessions,
        sessions: hotspot.sessions,
        mean_duration_ms: hotspot.mean_duration_ms,
        worst_step: worstStep,
        evidence: hotspot.evidence.slice(0, 10).map((moment) => ({
          video_id: moment.video_id,
          run_id: moment.run_id,
          t_ms: moment.t_ms,
          text: moment.text,
        })),
      },
      computed_at,
    }
  }

  const [goal] = await scopedDb.db
    .select({ id: goals.id, name: goals.name })
    .from(goals)
    .where(scopedDb.orgFilter(goals, eq(goals.id, source.goal_id)))
    .limit(1)
  if (!goal) return null
  const journeys = await scopedDb.db
    .select({ id: tasks.id, name: tasks.name })
    .from(tasks)
    .where(scopedDb.orgFilter(tasks, and(eq(tasks.goalId, goal.id))))
    .orderBy(asc(tasks.name))
  const sessions = await loadJourneySessions(orgId, scopedDb, journeys.map((j) => j.id))
  const board = compareJourneysOfGoal(journeys.map((j) => ({ ...j, sessions: sessions.get(j.id) ?? [] })))
  const easiest = board.journeys.find((journey) => journey.id === board.easiest_id)
  return {
    label: goal.name,
    headline: easiest
      ? `Easiest way: ${easiest.name} (median ${easiest.stats.median}, n=${easiest.stats.n}).`
      : "No journey has analyzed sessions yet.",
    key: board.easiest_id ?? "none",
    reference_fingerprint: board.reference_fingerprint,
    details: {
      ranking: board.journeys.map((journey) => ({
        id: journey.id,
        name: journey.name,
        median: journey.stats.median,
        n: journey.stats.n,
        verdict: journey.vs_easiest?.verdict.text ?? null,
      })),
    },
    computed_at,
  }
}

/** True when today's result no longer supports what was saved. */
export function findingChanged(saved: FindingSnapshot, live: FindingSnapshot | null): boolean {
  return !live || live.key !== saved.key
}

/**
 * True when the live result was computed under a different scoring definition than the saved one
 * (the journey was re-analyzed after JAMS's models or formula changed). The claim may still hold;
 * the page says it was recomputed rather than implying the numbers are directly comparable.
 */
export function findingRedefined(saved: FindingSnapshot, live: FindingSnapshot | null): boolean {
  return (
    !!live &&
    saved.reference_fingerprint !== null &&
    live.reference_fingerprint !== null &&
    saved.reference_fingerprint !== live.reference_fingerprint
  )
}
