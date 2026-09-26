import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { goals } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { updateGoalSchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const body = await parseJsonBody(request, updateGoalSchema)
    return await withOrg(async ({ scopedDb }) => {
      try {
        const [goal] = await scopedDb.db
          .update(goals)
          .set({
            name: body.name,
            description: body.description,
            successCriterion: body.success_criterion,
          })
          .where(scopedDb.orgFilter(goals, eq(goals.id, id)))
          .returning()
        if (!goal) return jsonError("Not found", 404)
        return NextResponse.json({
          goal: {
            id: goal.id,
            project_id: goal.projectId,
            name: goal.name,
            description: goal.description,
            success_criterion: goal.successCriterion,
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          return jsonError("A goal with that name already exists in this project", 409)
        }
        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
