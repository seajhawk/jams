import { and, asc, desc, eq } from "drizzle-orm"
import { z } from "zod"

import { analysisRuns, measures } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

const VALID_KINDS = new Set([
  "context_switch",
  "utterance",
  "spoken_word",
  "time_segment",
  "sentiment",
])

function serializeMeasure(m: typeof measures.$inferSelect) {
  return {
    id: m.id,
    run_id: m.runId,
    kind: m.kind,
    category: m.category,
    t_start_ms: m.tStartMs,
    t_end_ms: m.tEndMs ?? null,
    value_num: m.valueNum ?? null,
    value_text: m.valueText ?? null,
    unit: m.unit ?? null,
    confidence: m.confidence ?? null,
    source: m.source,
    provider_id: m.providerId,
    provider_version: m.providerVersion,
    payload: m.payload,
    created_at: m.createdAt.toISOString(),
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

    const url = new URL(request.url)
    const kindParam = url.searchParams.get("kind") ?? null
    const limitParam = url.searchParams.get("limit") ?? null

    if (kindParam !== null && !VALID_KINDS.has(kindParam)) {
      return jsonError("Invalid kind", 400)
    }

    const rawLimit = limitParam !== null ? parseInt(limitParam, 10) : null
    const limit =
      rawLimit !== null && !isNaN(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 1000)
        : null

    return await withOrg(async ({ scopedDb }) => {
      // Verify run exists and is scoped to the current org
      const [run] = await scopedDb.db
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(scopedDb.orgFilter(analysisRuns, eq(analysisRuns.id, id)))
        .limit(1)

      if (!run) {
        return jsonError("Not found", 404)
      }

      const runFilter = eq(measures.runId, id)
      const kindFilter = kindParam ? eq(measures.kind, kindParam) : undefined
      const extraFilter = kindFilter
        ? and(runFilter, kindFilter) ?? runFilter
        : runFilter

      const whereClause = scopedDb.orgFilter(measures, extraFilter)

      // Newest-first when a limit is requested; chronological otherwise
      const orderCol = limit ? desc(measures.createdAt) : asc(measures.tStartMs)

      const rows = await scopedDb.db
        .select()
        .from(measures)
        .where(whereClause)
        .orderBy(orderCol)
        .limit(limit ?? 10_000)

      return Response.json({ measures: rows.map(serializeMeasure) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
