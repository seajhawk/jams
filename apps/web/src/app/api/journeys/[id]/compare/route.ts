import { eq } from "drizzle-orm"
import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { tasks } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { compareWithinJourney } from "@/lib/comparisons"
import { loadJourneySessions } from "@/lib/hierarchy"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const querySchema = z.object({
  by: z.enum(["variant", "cohort"]),
  a: z.string().trim().min(1).max(120),
  b: z.string().trim().min(1).max(120),
})

/** Compare two variants (or two cohorts) of one journey on a single scoring definition. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
    if (!query.success) return jsonError("Pass by=variant|cohort, a and b", 400)
    if (query.data.a === query.data.b) return jsonError("Choose two different groups", 400)

    return await withOrg(async ({ orgId, scopedDb }) => {
      const [journey] = await scopedDb.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(scopedDb.orgFilter(tasks, eq(tasks.id, id)))
        .limit(1)
      if (!journey) return jsonError("Not found", 404)

      const sessions = (await loadJourneySessions(orgId, scopedDb, [id])).get(id) ?? []
      return NextResponse.json(
        compareWithinJourney(sessions, query.data.by, query.data.a, query.data.b)
      )
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
