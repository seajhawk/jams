import { handleRouteError, jsonError } from "@/lib/api"
import { requirePlatformAdminApi } from "@/lib/admin-auth"
import { requeueAnalysisPoisonMessage } from "@/lib/queue"

export const dynamic = "force-dynamic"

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requirePlatformAdminApi()
    const { id } = await params
    const requeued = await requeueAnalysisPoisonMessage(id)
    if (!requeued) {
      return jsonError("Poison message not found", 404)
    }

    console.info("admin_poison_requeued", { messageId: id, adminUserId: admin.userId })
    return Response.json({ status: "requeued" })
  } catch (error) {
    return handleRouteError(error)
  }
}
