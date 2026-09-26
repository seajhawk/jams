import { asc } from "drizzle-orm"
import { NextResponse } from "next/server"

import { goals, tasks } from "@/db/schema"
import {
  handleRouteError,
  isUniqueViolation,
  jsonError,
  parseJsonBody,
} from "@/lib/api"
import { assertInOrg, createJourneySchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

function serializeTask(task: typeof tasks.$inferSelect) {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    goal_id: task.goalId,
    steps: task.steps,
    status: task.status,
    created_at: task.createdAt.toISOString(),
  }
}

export async function GET() {
  try {
    return await withOrg(async ({ scopedDb }) => {
      const rows = await scopedDb.db
        .select()
        .from(tasks)
        .where(scopedDb.orgFilter(tasks))
        .orderBy(asc(tasks.name))

      return NextResponse.json({ tasks: rows.map(serializeTask) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createJourneySchema)

    return await withOrg(async ({ orgId, scopedDb }) => {
      if (body.goal_id) await assertInOrg(scopedDb, goals, body.goal_id, "Goal")
      try {
        const [task] = await scopedDb.db
          .insert(tasks)
          .values({
            orgId,
            name: body.name,
            description: body.description,
            goalId: body.goal_id,
            steps: body.steps ?? [],
          })
          .returning()

        return NextResponse.json({ task: serializeTask(task) }, { status: 201 })
      } catch (error) {
        if (isUniqueViolation(error)) {
          return jsonError("A journey with that name already exists", 409)
        }

        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
