import { z } from "zod"

import { handleRouteError, jsonError } from "@/lib/api"
import { assembleReportPayload, ReportNotFoundError, ReportNotReadyError } from "@/lib/report-assembly"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    return await withOrg(async ({ orgId }) => {
      const payload = await assembleReportPayload(id, orgId)
      return Response.json({ payload })
    })
  } catch (error) {
    if (error instanceof ReportNotFoundError || error instanceof ReportNotReadyError) {
      return jsonError(error.message, 404)
    }
    return handleRouteError(error)
  }
}
