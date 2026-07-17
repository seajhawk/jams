import { and, eq, isNull, ne } from "drizzle-orm"
import { NextResponse } from "next/server"

import { analysisRuns, videos } from "@/db/schema"
import { HttpError, handleRouteError, parseJsonBody } from "@/lib/api"
import { createAnalysisSchema, serializeAnalysisRun } from "@/lib/analyses"
import { PIPELINE_VERSION } from "@/lib/pipeline-version"
import { enqueueAnalysisRun } from "@/lib/queue"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createAnalysisSchema)

    return await withOrg(async ({ orgId, scopedDb }) => {
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

      const runId = crypto.randomUUID()
      const [run] = await scopedDb.db
        .insert(analysisRuns)
        .values({
          id: runId,
          orgId,
          videoId: body.video_id,
          config: body.config ?? {},
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

      await enqueueAnalysisRun(run.id)

      return NextResponse.json(
        { analysis: serializeAnalysisRun(run) },
        { status: 201 }
      )
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
