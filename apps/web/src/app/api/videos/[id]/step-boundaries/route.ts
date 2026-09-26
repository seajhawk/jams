import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { tasks, videos } from "@/db/schema"
import { handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import { validBoundaries } from "@/lib/steps"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const bodySchema = z.object({ boundaries_ms: z.array(z.number().int()).max(49) })

async function loadSession(scopedDb: Parameters<Parameters<typeof withOrg>[0]>[0]["scopedDb"], orgId: string, id: string) {
  const [row] = await scopedDb.db
    .select({ durationMs: videos.durationMs, steps: tasks.steps })
    .from(videos)
    .leftJoin(tasks, and(eq(tasks.id, videos.taskId), eq(tasks.orgId, orgId)))
    .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
    .limit(1)
  return row
}

/** Set a session's manual step boundaries: one cut between each pair of the journey's steps. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const body = await parseJsonBody(request, bodySchema)
    return await withOrg(async ({ orgId, scopedDb }) => {
      const session = await loadSession(scopedDb, orgId, id)
      if (!session) return jsonError("Not found", 404)
      const steps = session.steps ?? []
      if (steps.length < 2) return jsonError("This session's journey needs at least two steps", 400)
      if (!session.durationMs || !validBoundaries(body.boundaries_ms, steps.length, session.durationMs)) {
        return jsonError(
          `Give ${steps.length - 1} increasing times inside the session (0 to ${session.durationMs ?? "?"} ms)`,
          400
        )
      }
      await scopedDb.db
        .update(videos)
        .set({ stepBoundariesMs: body.boundaries_ms })
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
      return NextResponse.json({ boundaries_ms: body.boundaries_ms })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

/** Clear manual boundaries; the session goes back to automatic alignment. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    return await withOrg(async ({ scopedDb }) => {
      const [row] = await scopedDb.db
        .update(videos)
        .set({ stepBoundariesMs: null })
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
        .returning({ id: videos.id })
      if (!row) return jsonError("Not found", 404)
      return NextResponse.json({ boundaries_ms: null })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
