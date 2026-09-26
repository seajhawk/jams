import { NextResponse } from "next/server"

import { projects } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { createProjectSchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createProjectSchema)
    return await withOrg(async ({ orgId, scopedDb }) => {
      try {
        const [project] = await scopedDb.db
          .insert(projects)
          .values({ orgId, name: body.name, description: body.description })
          .returning()
        return NextResponse.json(
          {
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              created_at: project.createdAt.toISOString(),
            },
          },
          { status: 201 }
        )
      } catch (error) {
        if (isUniqueViolation(error)) return jsonError("A project with that name already exists", 409)
        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
