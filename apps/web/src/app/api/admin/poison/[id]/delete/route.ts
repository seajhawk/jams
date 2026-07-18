import { handleRouteError, jsonError } from "@/lib/api"
import { requirePlatformAdminApi } from "@/lib/admin-auth"
import { deleteAnalysisPoisonMessage } from "@/lib/queue"

export const dynamic = "force-dynamic"

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requirePlatformAdminApi()
    const { id } = await params
    const deleted = await deleteAnalysisPoisonMessage(id)
    if (!deleted) {
      return jsonError("Poison message not found", 404)
    }

    console.info("admin_poison_deleted", { messageId: id, adminUserId: admin.userId })
    return Response.json({ status: "deleted" })
  } catch (error) {
    return handleRouteError(error)
  }
}
