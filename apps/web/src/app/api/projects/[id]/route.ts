import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { projects } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { updateProjectSchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const body = await parseJsonBody(request, updateProjectSchema)
    return await withOrg(async ({ scopedDb }) => {
      try {
        const [project] = await scopedDb.db
          .update(projects)
          .set({ name: body.name, description: body.description })
          .where(scopedDb.orgFilter(projects, eq(projects.id, id)))
          .returning()
        if (!project) return jsonError("Not found", 404)
        return NextResponse.json({
          project: { id: project.id, name: project.name, description: project.description },
        })
      } catch (error) {
        if (isUniqueViolation(error)) return jsonError("A project with that name already exists", 409)
        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
