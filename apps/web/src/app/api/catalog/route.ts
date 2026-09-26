import { asc } from "drizzle-orm"
import { NextResponse } from "next/server"

import { goals, projects, tasks } from "@/db/schema"
import { handleRouteError } from "@/lib/api"
import { journeyStats, loadJourneySessions } from "@/lib/hierarchy"
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

      const journey = (row: (typeof journeyRows)[number]) => {
        const journeySessions = sessions.get(row.id) ?? []
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          status: row.status,
          steps: row.steps,
          stats: journeyStats(journeySessions),
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
