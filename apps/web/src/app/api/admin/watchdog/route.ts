import { handleRouteError } from "@/lib/api"
import { requireMachineOrPlatformAdminApi } from "@/lib/admin-auth"
import { markStuckRunsFailed, reconcilePendingDispatches } from "@/lib/admin-runs"
import { reconcileRecordingCleanup } from "@/lib/recording-cleanup"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const actor = await requireMachineOrPlatformAdminApi(request)
    const dispatchResults = await reconcilePendingDispatches()
    const rows = await markStuckRunsFailed(actor.userId)
    const cleanupResults = await reconcileRecordingCleanup()
    return Response.json({
      status: "ok",
      actor: actor.type,
      marked_failed: rows.length,
      reconciled_dispatches: dispatchResults.reconciledCount,
      run_ids: rows.map((row) => row.id),
      cleanup_swept_count: cleanupResults.sweptCount,
      cleanup_failed_count: cleanupResults.failedCount,
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
