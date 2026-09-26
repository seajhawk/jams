import { and, desc, eq, inArray } from "drizzle-orm"
import { NextResponse } from "next/server"

import { findings, goals, tasks } from "@/db/schema"
import { HttpError, handleRouteError, parseJsonBody } from "@/lib/api"
import {
  buildSnapshot,
  createFindingSchema,
  findingChanged,
  findingRedefined,
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
      // Which project each finding belongs to, so summaries can show findings per project.
      const sources = rows.map((row) => row.source as { journey_id?: string; goal_id?: string })
      const journeyIds = [...new Set(sources.flatMap((s) => (s.journey_id ? [s.journey_id] : [])))]
      const goalIds = [...new Set(sources.flatMap((s) => (s.goal_id ? [s.goal_id] : [])))]
      const [journeyProjects, goalProjects] = await Promise.all([
        journeyIds.length
          ? scopedDb.db
              .select({ id: tasks.id, projectId: goals.projectId })
              .from(tasks)
              .innerJoin(goals, and(eq(goals.id, tasks.goalId), eq(goals.orgId, orgId)))
              .where(scopedDb.orgFilter(tasks, inArray(tasks.id, journeyIds)))
          : [],
        goalIds.length
          ? scopedDb.db
              .select({ id: goals.id, projectId: goals.projectId })
              .from(goals)
              .where(scopedDb.orgFilter(goals, inArray(goals.id, goalIds)))
          : [],
      ])
      const projectOf = new Map([...journeyProjects, ...goalProjects].map((row) => [row.id, row.projectId]))

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
          project_id:
            projectOf.get((row.source as { journey_id?: string }).journey_id ?? "") ??
            projectOf.get((row.source as { goal_id?: string }).goal_id ?? "") ??
            null,
          live: live
            ? {
                headline: live.headline,
                changed: findingChanged(saved, live),
                redefined: findingRedefined(saved, live),
              }
            : null,
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
