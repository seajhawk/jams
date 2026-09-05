import { handleRouteError } from "@/lib/api"
import { requirePlatformAdminApi } from "@/lib/admin-auth"
import { markStuckRunsFailed, reconcilePendingDispatches } from "@/lib/admin-runs"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const admin = await requirePlatformAdminApi()
    const dispatchResults = await reconcilePendingDispatches()
    const rows = await markStuckRunsFailed(admin.userId)
    return Response.json({
      status: "ok",
      marked_failed: rows.length,
      reconciled_dispatches: dispatchResults.reconciledCount,
      run_ids: rows.map((row) => row.id),
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
