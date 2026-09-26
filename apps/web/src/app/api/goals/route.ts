import { NextResponse } from "next/server"

import { goals, projects } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { assertInOrg, createGoalSchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createGoalSchema)
    return await withOrg(async ({ orgId, scopedDb }) => {
      await assertInOrg(scopedDb, projects, body.project_id, "Project")
      try {
        const [goal] = await scopedDb.db
          .insert(goals)
          .values({
            orgId,
            projectId: body.project_id,
            name: body.name,
            description: body.description,
            successCriterion: body.success_criterion,
          })
          .returning()
        return NextResponse.json(
          {
            goal: {
              id: goal.id,
              project_id: goal.projectId,
              name: goal.name,
              description: goal.description,
              success_criterion: goal.successCriterion,
            },
          },
          { status: 201 }
        )
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
