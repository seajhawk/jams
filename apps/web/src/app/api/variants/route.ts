import { asc, eq } from "drizzle-orm"
import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { tasks, variants } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { assertInOrg, createVariantSchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

function serialize(row: typeof variants.$inferSelect) {
  return { id: row.id, task_id: row.taskId, name: row.name, build: row.build }
}

export async function GET(request: NextRequest) {
  try {
    const taskId = request.nextUrl.searchParams.get("task_id")
    if (!taskId || !z.string().uuid().safeParse(taskId).success) {
      return jsonError("task_id is required", 400)
    }
    return await withOrg(async ({ scopedDb }) => {
      const rows = await scopedDb.db
        .select()
        .from(variants)
        .where(scopedDb.orgFilter(variants, eq(variants.taskId, taskId)))
        .orderBy(asc(variants.name))
      return NextResponse.json({ variants: rows.map(serialize) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createVariantSchema)
    return await withOrg(async ({ orgId, scopedDb }) => {
      await assertInOrg(scopedDb, tasks, body.task_id, "Journey")
      try {
        const [row] = await scopedDb.db
          .insert(variants)
          .values({ orgId, taskId: body.task_id, name: body.name, build: body.build })
          .returning()
        return NextResponse.json({ variant: serialize(row) }, { status: 201 })
      } catch (error) {
        if (isUniqueViolation(error)) {
          return jsonError("A variant with that name already exists for this journey", 409)
        }
        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
