import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { goals, tasks } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { assertInOrg, updateJourneySchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const body = await parseJsonBody(request, updateJourneySchema)
    return await withOrg(async ({ scopedDb }) => {
      if (body.goal_id) await assertInOrg(scopedDb, goals, body.goal_id, "Goal")
      try {
        const [task] = await scopedDb.db
          .update(tasks)
          .set({
            name: body.name,
            description: body.description,
            goalId: body.goal_id,
            steps: body.steps,
            status: body.status,
          })
          .where(scopedDb.orgFilter(tasks, eq(tasks.id, id)))
          .returning()
        if (!task) return jsonError("Not found", 404)
        return NextResponse.json({
          task: {
            id: task.id,
            name: task.name,
            description: task.description,
            goal_id: task.goalId,
            steps: task.steps,
            status: task.status,
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) return jsonError("A journey with that name already exists", 409)
        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
