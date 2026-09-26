import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { goals, projects, tasks } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { journeyStats, loadJourneySessions } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    return await withOrg(async ({ orgId, scopedDb }) => {
      const [row] = await scopedDb.db
        .select({ journey: tasks, goal: goals, project: projects })
        .from(tasks)
        .leftJoin(goals, and(eq(goals.id, tasks.goalId), eq(goals.orgId, orgId)))
        .leftJoin(projects, and(eq(projects.id, goals.projectId), eq(projects.orgId, orgId)))
        .where(scopedDb.orgFilter(tasks, eq(tasks.id, id)))
        .limit(1)
      if (!row) return jsonError("Not found", 404)

      const sessions = (await loadJourneySessions(orgId, scopedDb, [id])).get(id) ?? []
      return NextResponse.json({
        journey: {
          id: row.journey.id,
          name: row.journey.name,
          description: row.journey.description,
          steps: row.journey.steps,
          status: row.journey.status,
        },
        goal: row.goal
          ? { id: row.goal.id, name: row.goal.name, success_criterion: row.goal.successCriterion }
          : null,
        project: row.project ? { id: row.project.id, name: row.project.name } : null,
        stats: journeyStats(sessions),
        sessions,
      })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
