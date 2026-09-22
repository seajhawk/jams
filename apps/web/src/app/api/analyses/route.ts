import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm"
import { NextResponse } from "next/server"

import { analysisRuns, videos } from "@/db/schema"
import { HttpError, handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import {
  createAnalysisSchema,
  serializeAnalysisRun,
  validateAnalysisConfig,
} from "@/lib/analyses"
import { dispatchAnalysisRun, recordDispatchIntent } from "@/lib/analysis-dispatch"
import { PIPELINE_VERSION } from "@/lib/pipeline-version"
import { assertAnalysisAdmission } from "@/lib/preview-limits"
import { getOrCreateDefaultProfile } from "@/lib/report-assembly"
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
      const [video] = await scopedDb.db
        .select({ id: videos.id, status: videos.status })
        .from(videos)
        .where(scopedDb.orgFilter(videos, eq(videos.id, body.video_id)))
        .for("update")
        .limit(1)

      if (!video) {
        throw new HttpError(404, "Video not found")
      }

      if (video.status !== "uploaded") {
        throw new HttpError(400, "Video must be uploaded before analysis")
      }

      const configResult =
        body.config === undefined
          ? null
          : validateAnalysisConfig(body.config)
      if (configResult?.success === false) {
        throw new HttpError(400, configResult.error)
      }

      await assertAnalysisAdmission(scopedDb)

      // A first upload can arrive before the organization webhook provisions
      // its profile. Commit the scoring prerequisite before dispatching work.
      await getOrCreateDefaultProfile(orgId, scopedDb)

      const runId = crypto.randomUUID()
      const [run] = await scopedDb.db
        .insert(analysisRuns)
        .values({
          id: runId,
          orgId,
          videoId: body.video_id,
          config: configResult?.config ?? {},
          configSource: body.config_source ?? null,
          pipelineVersion: PIPELINE_VERSION,
          status: "queued",
          stage: "queued",
          progressPct: 0,
          stageDetail: "Waiting for worker",
        })
        .returning()

      await scopedDb.db
        .update(analysisRuns)
        .set({ supersededBy: runId })
        .where(
          and(
            eq(analysisRuns.orgId, orgId),
            eq(analysisRuns.videoId, body.video_id),
            isNull(analysisRuns.supersededBy),
            ne(analysisRuns.id, runId)
          )
        )

      const outbox = await recordDispatchIntent(scopedDb.db, {
        runId: run.id,
        orgId,
      })

      return { run, outboxId: outbox.id }
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
