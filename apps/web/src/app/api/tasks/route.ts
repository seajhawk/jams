import { asc } from "drizzle-orm"
import { NextResponse } from "next/server"

import { tasks } from "@/db/schema"
import {
  handleRouteError,
  isUniqueViolation,
  jsonError,
  parseJsonBody,
} from "@/lib/api"
import { createTaskSchema } from "@/lib/videos"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

function serializeTask(task: typeof tasks.$inferSelect) {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
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
    const body = await parseJsonBody(request, createTaskSchema)

    return await withOrg(async ({ orgId, scopedDb }) => {
      try {
        const [task] = await scopedDb.db
          .insert(tasks)
          .values({
            orgId,
            name: body.name,
            description: body.description,
          })
          .returning()

        return NextResponse.json({ task: serializeTask(task) }, { status: 201 })
      } catch (error) {
        if (isUniqueViolation(error)) {
          return jsonError("A task with that name already exists", 409)
        }

        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
