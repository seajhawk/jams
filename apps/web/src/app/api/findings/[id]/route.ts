import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { findings } from "@/db/schema"
import { handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import { updateFindingSchema } from "@/lib/findings"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const body = await parseJsonBody(request, updateFindingSchema)
    return await withOrg(async ({ scopedDb }) => {
      const [row] = await scopedDb.db
        .update(findings)
        .set({ title: body.title, note: body.note })
        .where(scopedDb.orgFilter(findings, eq(findings.id, id)))
        .returning({ id: findings.id, title: findings.title, note: findings.note })
      if (!row) return jsonError("Not found", 404)
      return NextResponse.json({ finding: row })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    return await withOrg(async ({ scopedDb }) => {
      const [row] = await scopedDb.db
        .delete(findings)
        .where(scopedDb.orgFilter(findings, eq(findings.id, id)))
        .returning({ id: findings.id })
      if (!row) return jsonError("Not found", 404)
      return NextResponse.json({ deleted: row.id })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
