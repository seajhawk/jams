import { eq } from "drizzle-orm"
import { z } from "zod"

import { analysisRuns } from "@/db/schema"
import { jsonError, handleRouteError } from "@/lib/api"
import { measuresToCsv, reportJson, selectExportMeasures } from "@/lib/report-export"
import {
  assembleReportPayload,
  ReportNotFoundError,
  ReportNotReadyError,
} from "@/lib/report-assembly"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()
const formatSchema = z.enum(["csv", "json"])

function exportHeaders(runId: string, ext: "csv" | "json") {
  return {
    "content-disposition": `attachment; filename="jams-report-${runId}.${ext}"`,
    "content-type": ext === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    const format = formatSchema.safeParse(new URL(request.url).searchParams.get("format"))
    if (!format.success) {
      return jsonError("format must be csv or json", 400)
    }

    return await withOrg(async ({ orgId, scopedDb }) => {
      const [run] = await scopedDb.db
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(scopedDb.orgFilter(analysisRuns, eq(analysisRuns.id, id)))
        .limit(1)

      if (!run) {
        return jsonError("Not found", 404)
      }

      if (format.data === "json") {
        const payload = await assembleReportPayload(id, orgId, scopedDb)
        return new Response(reportJson(payload), {
          headers: exportHeaders(id, "json"),
        })
      }

      const rows = await selectExportMeasures(scopedDb, id)
      return new Response(measuresToCsv(rows), {
        headers: exportHeaders(id, "csv"),
      })
    })
  } catch (error) {
    if (error instanceof ReportNotFoundError || error instanceof ReportNotReadyError) {
      return jsonError(error.message, 404)
    }
    return handleRouteError(error)
  }
}
