import { asc } from "drizzle-orm"
import { NextResponse } from "next/server"

import { participants } from "@/db/schema"
import { handleRouteError, isUniqueViolation, jsonError, parseJsonBody } from "@/lib/api"
import { createParticipantSchema } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

function serialize(row: typeof participants.$inferSelect) {
  return { id: row.id, label: row.label, cohorts: row.cohorts, notes: row.notes }
}

export async function GET() {
  try {
    return await withOrg(async ({ scopedDb }) => {
      const rows = await scopedDb.db
        .select()
        .from(participants)
        .where(scopedDb.orgFilter(participants))
        .orderBy(asc(participants.label))
      return NextResponse.json({ participants: rows.map(serialize) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createParticipantSchema)
    return await withOrg(async ({ orgId, scopedDb }) => {
      try {
        const [row] = await scopedDb.db
          .insert(participants)
          .values({ orgId, label: body.label, cohorts: body.cohorts ?? [], notes: body.notes })
          .returning()
        return NextResponse.json({ participant: serialize(row) }, { status: 201 })
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
