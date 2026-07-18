import { eq } from "drizzle-orm"
import { z } from "zod"

import { shareLinks } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { serializeShareLink } from "@/lib/share-links"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    return await withOrg(async ({ scopedDb }) => {
      const [revoked] = await scopedDb.db
        .update(shareLinks)
        .set({ revokedAt: new Date() })
        .where(scopedDb.orgFilter(shareLinks, eq(shareLinks.id, id)))
        .returning()

      if (!revoked) {
        return jsonError("Not found", 404)
      }

      return Response.json({ link: serializeShareLink(revoked) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
