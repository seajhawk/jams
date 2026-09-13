import { handleRouteError } from "@/lib/api"
import { requireMachineOrPlatformAdminApi } from "@/lib/admin-auth"
import { reconcilePendingDispatches } from "@/lib/admin-runs"
import { reconcileRecordingCleanup } from "@/lib/recording-cleanup"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const actor = await requireMachineOrPlatformAdminApi(request)
    const dispatchResults = await reconcilePendingDispatches()
    const cleanupResults = await reconcileRecordingCleanup()
    return Response.json({
      status: "ok",
      actor: actor.type,
      reconciled_count: dispatchResults.reconciledCount,
      failed_count: dispatchResults.failedCount,
      skipped_count: dispatchResults.skippedCount,
      dispatched_run_ids: dispatchResults.dispatchedRunIds,
      cleanup_swept_count: cleanupResults.sweptCount,
      cleanup_failed_count: cleanupResults.failedCount,
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
