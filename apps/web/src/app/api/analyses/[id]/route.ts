import { eq } from "drizzle-orm"
import { z } from "zod"

import { analysisRuns } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { serializeAnalysisRun } from "@/lib/analyses"
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

    return await withOrg(async ({ scopedDb }) => {
      const [run] = await scopedDb.db
        .select()
        .from(analysisRuns)
        .where(scopedDb.orgFilter(analysisRuns, eq(analysisRuns.id, id)))
        .limit(1)

      if (!run) {
        return jsonError("Not found", 404)
      }

      return Response.json({ analysis: serializeAnalysisRun(run) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
