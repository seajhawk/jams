import { and, asc, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { goals, projects, tasks } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { compareJourneysOfGoal } from "@/lib/comparisons"
import { loadJourneySessions } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

/** The journeys of one goal, easiest first, each compared with the easiest. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)

    return await withOrg(async ({ orgId, scopedDb }) => {
      const [row] = await scopedDb.db
        .select({ goal: goals, project: { id: projects.id, name: projects.name } })
        .from(goals)
        .leftJoin(projects, and(eq(projects.id, goals.projectId), eq(projects.orgId, orgId)))
        .where(scopedDb.orgFilter(goals, eq(goals.id, id)))
        .limit(1)
      if (!row) return jsonError("Not found", 404)

      const journeyRows = await scopedDb.db
        .select({ id: tasks.id, name: tasks.name })
        .from(tasks)
        .where(scopedDb.orgFilter(tasks, eq(tasks.goalId, id)))
        .orderBy(asc(tasks.name))
      const sessions = await loadJourneySessions(
        orgId,
        scopedDb,
        journeyRows.map((journey) => journey.id)
      )

      return NextResponse.json({
        goal: {
          id: row.goal.id,
          name: row.goal.name,
          description: row.goal.description,
          success_criterion: row.goal.successCriterion,
        },
        project: row.project?.id ? row.project : null,
        ...compareJourneysOfGoal(
          journeyRows.map((journey) => ({ ...journey, sessions: sessions.get(journey.id) ?? [] }))
        ),
      })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
