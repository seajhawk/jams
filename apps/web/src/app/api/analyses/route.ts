import { and, eq, isNull, ne } from "drizzle-orm"
import { NextResponse } from "next/server"

import { analysisRuns, videos } from "@/db/schema"
import { HttpError, handleRouteError, parseJsonBody } from "@/lib/api"
import {
  createAnalysisSchema,
  serializeAnalysisRun,
  validateAnalysisConfig,
} from "@/lib/analyses"
import { dispatchAnalysisRun, recordDispatchIntent } from "@/lib/analysis-dispatch"
import { PIPELINE_VERSION } from "@/lib/pipeline-version"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createAnalysisSchema)

    const created = await withOrg(async ({ orgId, scopedDb }) => {
      const [video] = await scopedDb.db
        .select({ id: videos.id, status: videos.status })
        .from(videos)
        .where(scopedDb.orgFilter(videos, eq(videos.id, body.video_id)))
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
