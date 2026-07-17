import { eq } from "drizzle-orm"
import { z } from "zod"

import { weightProfiles } from "@/db/schema"
import { handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import { measureKindSchema, normalizationSchema } from "@/lib/report-contract"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

const patchProfileSchema = z.object({
  weights: z.partialRecord(measureKindSchema, z.number().min(0)).optional(),
  normalization: z.partialRecord(measureKindSchema, normalizationSchema).optional(),
})

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    const body = await parseJsonBody(request, patchProfileSchema)

    return await withOrg(async ({ scopedDb }) => {
      const [existing] = await scopedDb.db
        .select()
        .from(weightProfiles)
        .where(
          scopedDb.orgFilter(
            weightProfiles,
            eq(weightProfiles.id, id)
          )
        )
        .limit(1)

      if (!existing) return jsonError("Not found", 404)
      if (!existing.isDefault) return jsonError("Only the default profile can be updated", 403)

      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
      }
      if (body.weights !== undefined) updates.weights = body.weights
      if (body.normalization !== undefined) updates.normalization = body.normalization

      const [updated] = await scopedDb.db
        .update(weightProfiles)
        .set(updates)
        .where(
          scopedDb.orgFilter(
            weightProfiles,
            eq(weightProfiles.id, id)
          )
        )
        .returning()

      return Response.json({ profile: updated })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
