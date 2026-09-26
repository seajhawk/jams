import { and, asc, inArray, lte, eq } from "drizzle-orm"
import { NextResponse } from "next/server"

import { goals, measures, projects, tasks } from "@/db/schema"
import { handleRouteError } from "@/lib/api"
import { isComparable, journeyStats, loadJourneySessions, referenceFingerprint } from "@/lib/hierarchy"
import { FRUSTRATED_THRESHOLD } from "@/lib/report-moments"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The workspace's projects → goals → journeys, each journey with session counts and the median
 * of its sessions' latest totals. Journeys created before U1 without a goal appear under
 * `ungrouped_journeys`.
 */
export async function GET() {
  try {
    return await withOrg(async ({ orgId, scopedDb }) => {
      const [projectRows, goalRows, journeyRows] = await Promise.all([
        scopedDb.db.select().from(projects).where(scopedDb.orgFilter(projects)).orderBy(asc(projects.name)),
        scopedDb.db.select().from(goals).where(scopedDb.orgFilter(goals)).orderBy(asc(goals.name)),
        scopedDb.db.select().from(tasks).where(scopedDb.orgFilter(tasks)).orderBy(asc(tasks.name)),
      ])
      const sessions = await loadJourneySessions(
        orgId,
        scopedDb,
        journeyRows.map((row) => row.id)
      )

      // Frustration indicator: comparable sessions whose latest analysis has a frustrated moment.
      // One grouped query for the whole catalog; step-level detail lives on the journey page.
      const comparableRunIds = [...sessions.values()].flatMap((journeySessions) => {
        const reference = referenceFingerprint(journeySessions)
        return journeySessions.flatMap((session) =>
          isComparable(session, reference) ? [session.analysis!.id] : []
        )
      })
      const frustratedRuns = new Set(
        comparableRunIds.length
          ? (
              await scopedDb.db
                .selectDistinct({ runId: measures.runId })
                .from(measures)
                .where(
                  scopedDb.orgFilter(
                    measures,
                    and(
                      inArray(measures.runId, comparableRunIds),
                      eq(measures.kind, "sentiment"),
                      lte(measures.valueNum, FRUSTRATED_THRESHOLD)
                    )
                  )
                )
            ).map((row) => row.runId)
          : []
      )

      const journey = (row: (typeof journeyRows)[number]) => {
        const journeySessions = sessions.get(row.id) ?? []
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          status: row.status,
          steps: row.steps,
          stats: journeyStats(journeySessions),
          frustrated_sessions: journeySessions.filter(
            (session) => session.analysis && frustratedRuns.has(session.analysis.id)
          ).length,
          last_session_at: journeySessions[0]?.created_at ?? null,
          recent_session_count: journeySessions.filter(
            (session) => Date.parse(session.created_at) >= Date.now() - RECENT_WINDOW_MS
          ).length,
        }
      }

      return NextResponse.json({
        projects: projectRows.map((project) => ({
          id: project.id,
          name: project.name,
          description: project.description,
          goals: goalRows
            .filter((goal) => goal.projectId === project.id)
            .map((goal) => ({
              id: goal.id,
              name: goal.name,
              description: goal.description,
              success_criterion: goal.successCriterion,
              journeys: journeyRows.filter((row) => row.goalId === goal.id).map(journey),
            })),
        })),
        ungrouped_journeys: journeyRows.filter((row) => row.goalId === null).map(journey),
      })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
