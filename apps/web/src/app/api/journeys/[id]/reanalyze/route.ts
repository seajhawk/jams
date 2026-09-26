import { and, desc, eq, inArray } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { analysisRuns, tasks } from "@/db/schema"
import { dispatchAnalysisRun } from "@/lib/analysis-dispatch"
import { HttpError, handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import { outdatedSessions } from "@/lib/comparisons"
import { loadJourneySessions } from "@/lib/hierarchy"
import { PreviewLimitError } from "@/lib/preview-limits"
import { queueAnalysisInScope } from "@/lib/queue-analysis"
import { splitByReferenceFingerprint } from "@/lib/stats"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const bodySchema = z.object({ only: z.literal("outdated") })

/**
 * Re-analyze a journey's sessions that are not on its current scoring definition (never
 * analyzed, failed, or scored under an older definition), with the configuration of the newest
 * analysis. Explicit and quota-aware: stops at the first preview limit and reports the rest.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    await parseJsonBody(request, bodySchema)

    const result = await withOrg(async ({ orgId, scopedDb }) => {
      const [journey] = await scopedDb.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(scopedDb.orgFilter(tasks, eq(tasks.id, id)))
        .limit(1)
      if (!journey) throw new HttpError(404, "Not found")

      const sessions = (await loadJourneySessions(orgId, scopedDb, [id])).get(id) ?? []
      const { reference } = splitByReferenceFingerprint(sessions)
      // Reuse the reference run's config so re-analysis converges on one definition; with no
      // reference yet (only legacy, failed or unanalyzed sessions), the newest run's config.
      const videoIds = sessions.map((session) => session.video_id)
      const newestRun = async (fingerprint: string | null) =>
        videoIds.length === 0
          ? undefined
          : (
              await scopedDb.db
                .select({ config: analysisRuns.config })
                .from(analysisRuns)
                .where(
                  scopedDb.orgFilter(
                    analysisRuns,
                    fingerprint
                      ? and(eq(analysisRuns.fingerprintHash, fingerprint), inArray(analysisRuns.videoId, videoIds))
                      : inArray(analysisRuns.videoId, videoIds)
                  )
                )
                .orderBy(desc(analysisRuns.createdAt))
                .limit(1)
            )[0]
      const referenceRun = (reference ? await newestRun(reference) : undefined) ?? (await newestRun(null))

      const queued: { runId: string; outboxId: string; videoId: string }[] = []
      const skipped: { video_id: string; reason: string }[] = []
      let limitReached: string | null = null
      for (const session of outdatedSessions(sessions)) {
        if (limitReached) {
          skipped.push({ video_id: session.video_id, reason: limitReached })
          continue
        }
        try {
          const { run, outboxId } = await queueAnalysisInScope(orgId, scopedDb, {
            videoId: session.video_id,
            config: referenceRun?.config ?? {},
            configSource: "reanalyze_outdated",
          })
          queued.push({ runId: run.id, outboxId, videoId: session.video_id })
        } catch (error) {
          if (error instanceof PreviewLimitError) {
            limitReached = error.message
            skipped.push({ video_id: session.video_id, reason: error.message })
          } else if (error instanceof HttpError && error.status === 400) {
            skipped.push({ video_id: session.video_id, reason: error.message })
          } else {
            throw error
          }
        }
      }
      return { queued, skipped }
    })

    // Committed; dispatch outside the transaction, like POST /api/analyses.
    for (const item of result.queued) {
      await dispatchAnalysisRun({ runId: item.runId, outboxId: item.outboxId })
    }
    return NextResponse.json({
      queued: result.queued.map((item) => ({ video_id: item.videoId, analysis_id: item.runId })),
      skipped: result.skipped,
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
