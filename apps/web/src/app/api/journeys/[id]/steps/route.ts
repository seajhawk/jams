import { eq } from "drizzle-orm"
import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { tasks } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { loadJourneySteps } from "@/lib/journey-steps"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

/** Step alignment of each comparable session and the journey's friction hotspots. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!z.string().uuid().safeParse(id).success) return jsonError("Not found", 404)
    const cohort = request.nextUrl.searchParams.get("cohort")
    const variant = request.nextUrl.searchParams.get("variant")

    return await withOrg(async ({ orgId, scopedDb }) => {
      const [journey] = await scopedDb.db
        .select({ id: tasks.id, steps: tasks.steps })
        .from(tasks)
        .where(scopedDb.orgFilter(tasks, eq(tasks.id, id)))
        .limit(1)
      if (!journey) return jsonError("Not found", 404)
      return NextResponse.json(await loadJourneySteps(orgId, scopedDb, journey, { cohort, variant }))
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
