import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { participants } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { updateParticipantSchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const body = await parseJsonBody(request, updateParticipantSchema)
    return await withOrg(async ({ scopedDb }) => {
      try {
        const [row] = await scopedDb.db
          .update(participants)
          .set({ label: body.label, cohorts: body.cohorts, notes: body.notes })
          .where(scopedDb.orgFilter(participants, eq(participants.id, id)))
          .returning()
        if (!row) return jsonError("Not found", 404)
        return NextResponse.json({
          participant: { id: row.id, label: row.label, cohorts: row.cohorts, notes: row.notes },
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          return jsonError("A participant with that label already exists", 409)
        }
        throw error
      }
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
