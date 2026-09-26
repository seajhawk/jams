import { desc } from "drizzle-orm"
import { NextResponse } from "next/server"

import { findings } from "@/db/schema"
import { HttpError, handleRouteError, parseJsonBody } from "@/lib/api"
import {
  buildSnapshot,
  createFindingSchema,
  findingChanged,
  findingSourceSchema,
  type FindingSnapshot,
} from "@/lib/findings"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

/** Saved findings, newest first, each checked against today's result. */
export async function GET() {
  try {
    return await withOrg(async ({ orgId, scopedDb }) => {
      const rows = await scopedDb.db
        .select()
        .from(findings)
        .where(scopedDb.orgFilter(findings))
        .orderBy(desc(findings.createdAt))
        .limit(50)
      const results = []
      for (const row of rows) {
        const source = findingSourceSchema.safeParse(row.source)
        const live = source.success ? await buildSnapshot(orgId, scopedDb, source.data) : null
        const saved = row.snapshot as unknown as FindingSnapshot
        results.push({
          id: row.id,
          title: row.title,
          note: row.note,
          kind: row.kind,
          source: row.source,
          snapshot: saved,
          created_at: row.createdAt.toISOString(),
          live: live ? { headline: live.headline, changed: findingChanged(saved, live) } : null,
        })
      }
      return NextResponse.json({ findings: results })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

/** Save a finding. The snapshot is recomputed here from the source, never taken from the client. */
export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createFindingSchema)
    return await withOrg(async ({ orgId, userId, scopedDb }) => {
      const snapshot = await buildSnapshot(orgId, scopedDb, body.source)
      if (!snapshot) throw new HttpError(400, "The journey, step or goal this finding refers to was not found")
      const [row] = await scopedDb.db
        .insert(findings)
        .values({
          orgId,
          title: body.title,
          note: body.note,
          kind: body.source.kind,
          source: body.source,
          snapshot: snapshot as unknown as Record<string, unknown>,
          createdBy: userId,
        })
        .returning()
      return NextResponse.json(
        { finding: { id: row.id, title: row.title, kind: row.kind, snapshot } },
        { status: 201 }
      )
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
