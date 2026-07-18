import { z } from "zod"

import { handleRouteError, jsonError } from "@/lib/api"
import { requirePlatformAdminApi } from "@/lib/admin-auth"
import { markAdminRunFailed } from "@/lib/admin-runs"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requirePlatformAdminApi()
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    const result = await markAdminRunFailed(id, admin.userId)
    if (result.status === "not_found") {
      return jsonError("Not found", 404)
    }
    if (result.status === "not_stuck") {
      return jsonError("Run is not stuck", 409)
    }

    return Response.json(result)
  } catch (error) {
    return handleRouteError(error)
  }
}
