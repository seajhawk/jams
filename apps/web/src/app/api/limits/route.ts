import { NextResponse } from "next/server"

import { handleRouteError } from "@/lib/api"
import { clientUploadLimits, limitPolicyForOrg } from "@/lib/limits"
import { resolveOrgContext } from "@/lib/with-org"

export const dynamic = "force-dynamic"

/**
 * The upload limits for the signed-in workspace, so the upload dialog can reject a recording
 * before sending a byte. Same policy the server enforces; the server checks again regardless.
 */
export async function GET() {
  try {
    const { orgId } = await resolveOrgContext()
    return NextResponse.json(
      { upload: clientUploadLimits(limitPolicyForOrg(orgId)) },
      { headers: { "Cache-Control": "private, max-age=300" } }
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
