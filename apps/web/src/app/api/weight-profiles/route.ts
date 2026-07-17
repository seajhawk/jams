import { handleRouteError } from "@/lib/api"
import { getOrCreateDefaultProfile } from "@/lib/report-assembly"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return await withOrg(async ({ orgId }) => {
      const profile = await getOrCreateDefaultProfile(orgId)
      return Response.json({ profile })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
