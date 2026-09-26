import { desc, eq, inArray } from "drizzle-orm"
import { NextResponse } from "next/server"

import { analysisRuns, videos } from "@/db/schema"
import { HttpError, handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import {
  createAnalysisSchema,
  serializeAnalysisRun,
  validateAnalysisConfig,
} from "@/lib/analyses"
import { dispatchAnalysisRun } from "@/lib/analysis-dispatch"
import { queueAnalysisInScope } from "@/lib/queue-analysis"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

/**
 * The runs still doing work, for the app-wide progress watcher. Deliberately narrow: `active=1` is
 * the only supported listing, so this never becomes a general run-history endpoint by accident.
 */
export async function GET(request: Request) {
  try {
    const active = new URL(request.url).searchParams.get("active")
    if (active !== "1") {
      return jsonError("Unsupported query; pass active=1", 400)
    }

    return await withOrg(async ({ scopedDb }) => {
      const rows = await scopedDb.db
        .select({ run: analysisRuns, videoTitle: videos.title })
        .from(analysisRuns)
        .leftJoin(videos, eq(videos.id, analysisRuns.videoId))
        .where(
          scopedDb.orgFilter(
            analysisRuns,
            inArray(analysisRuns.status, ["queued", "running"])
          )
        )
        .orderBy(desc(analysisRuns.createdAt))

      return Response.json({
        analyses: rows.map(({ run, videoTitle }) => ({
          ...serializeAnalysisRun(run),
          video_title: videoTitle,
        })),
      })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createAnalysisSchema)

    const created = await withOrg(async ({ orgId, scopedDb }) => {
      const configResult =
        body.config === undefined
          ? null
          : validateAnalysisConfig(body.config)
      if (configResult?.success === false) {
        throw new HttpError(400, configResult.error)
      }

      return queueAnalysisInScope(orgId, scopedDb, {
        videoId: body.video_id,
        config: configResult?.config ?? {},
        configSource: body.config_source ?? null,
      })
    })

    // Transaction is committed and visible in PostgreSQL. Dispatch outside the transaction.
    await dispatchAnalysisRun({
      runId: created.run.id,
      outboxId: created.outboxId,
    })

    return NextResponse.json(
      { analysis: serializeAnalysisRun(created.run) },
      { status: 201 }
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
