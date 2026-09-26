import { handleRouteError } from "@/lib/api"
import { requireMachineOrPlatformAdminApi } from "@/lib/admin-auth"
import { markStuckRunsFailed, reconcilePendingDispatches } from "@/lib/admin-runs"
import { purgeExpiredRateLimitCounters } from "@/lib/rate-limit"
import { reconcileRecordingCleanup } from "@/lib/recording-cleanup"
import { sweepStaleUploads } from "@/lib/upload-cleanup"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const actor = await requireMachineOrPlatformAdminApi(request)
    const dispatchResults = await reconcilePendingDispatches()
    const rows = await markStuckRunsFailed(actor.userId)
    const cleanupResults = await reconcileRecordingCleanup()
    const uploadResults = await sweepStaleUploads()
    const purgedRateCounters = await purgeExpiredRateLimitCounters()
    return Response.json({
      status: "ok",
      actor: actor.type,
      marked_failed: rows.length,
      reconciled_dispatches: dispatchResults.reconciledCount,
      run_ids: rows.map((row) => row.id),
      cleanup_swept_count: cleanupResults.sweptCount,
      cleanup_failed_count: cleanupResults.failedCount,
      stale_uploads_failed: uploadResults.markedFailedCount,
      upload_sources_cleaned: uploadResults.cleanedCount,
      upload_source_cleanup_failed_count: uploadResults.failedCount,
      rate_limit_counters_purged: purgedRateCounters,
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
