import { and, eq, isNull, ne } from "drizzle-orm"

import { analysisRuns, videos } from "@/db/schema"
import { recordDispatchIntent } from "@/lib/analysis-dispatch"
import { HttpError } from "@/lib/api"
import { PIPELINE_VERSION } from "@/lib/pipeline-version"
import { assertAnalysisAdmission } from "@/lib/preview-limits"
import { getOrCreateDefaultProfile } from "@/lib/report-assembly"
import type { OrgContext } from "@/lib/with-org"

/**
 * Queue one analysis of a session inside the caller's transaction: lock the video, check it is
 * uploaded and admitted under preview limits, make sure scoring can run, insert the run, supersede
 * earlier runs, and record the dispatch intent. The caller dispatches after commit.
 */
export async function queueAnalysisInScope(
  orgId: string,
  scopedDb: OrgContext["scopedDb"],
  input: { videoId: string; config: Record<string, unknown>; configSource: string | null }
) {
  const [video] = await scopedDb.db
    .select({ id: videos.id, status: videos.status })
    .from(videos)
    .where(scopedDb.orgFilter(videos, eq(videos.id, input.videoId)))
    .for("update")
    .limit(1)

  if (!video) throw new HttpError(404, "Video not found")
  if (video.status !== "uploaded") {
    throw new HttpError(400, "Video must be uploaded before analysis")
  }

  await assertAnalysisAdmission(scopedDb)

  // A first upload can arrive before the organization webhook provisions its profile. Commit the
  // scoring prerequisite before dispatching work.
  await getOrCreateDefaultProfile(orgId, scopedDb)

  const runId = crypto.randomUUID()
  const [run] = await scopedDb.db
    .insert(analysisRuns)
    .values({
      id: runId,
      orgId,
      videoId: input.videoId,
      config: input.config,
      configSource: input.configSource,
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
        eq(analysisRuns.videoId, input.videoId),
        isNull(analysisRuns.supersededBy),
        ne(analysisRuns.id, runId)
      )
    )

  const outbox = await recordDispatchIntent(scopedDb.db, { runId: run.id, orgId })
  return { run, outboxId: outbox.id }
}
