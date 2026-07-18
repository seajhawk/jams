import { and, desc, eq, lte } from "drizzle-orm"

import { adminDb } from "@/db/admin-client.server"
import { analysisRuns, videos } from "@/db/schema"
import { enqueueAnalysisRun } from "@/lib/queue"

export const stuckRunAgeMs = 60 * 60 * 1000

export type AdminRunFilter = "failed" | "partial" | "stuck"

export type AdminRunRow = {
  id: string
  orgId: string
  videoId: string
  videoTitle: string | null
  status: string
  stage: string
  stageDetail: string | null
  errorCode: string | null
  attempt: number
  startedAt: Date | null
  updatedAt: Date
  providerResults: unknown
}

export function stuckCutoff(now = new Date()) {
  return new Date(now.getTime() - stuckRunAgeMs)
}

export function adminRunFilterCondition(filter: AdminRunFilter, now = new Date()) {
  if (filter === "stuck") {
    return and(
      eq(analysisRuns.status, "running"),
      lte(analysisRuns.updatedAt, stuckCutoff(now))
    )
  }

  return eq(analysisRuns.status, filter)
}

export async function listAdminRuns(filter: AdminRunFilter) {
  return adminDb
    .select({
      id: analysisRuns.id,
      orgId: analysisRuns.orgId,
      videoId: analysisRuns.videoId,
      videoTitle: videos.title,
      status: analysisRuns.status,
      stage: analysisRuns.stage,
      stageDetail: analysisRuns.stageDetail,
      errorCode: analysisRuns.errorCode,
      attempt: analysisRuns.attempt,
      startedAt: analysisRuns.startedAt,
      updatedAt: analysisRuns.updatedAt,
      providerResults: analysisRuns.providerResults,
    })
    .from(analysisRuns)
    .leftJoin(videos, eq(analysisRuns.videoId, videos.id))
    .where(adminRunFilterCondition(filter))
    .orderBy(desc(analysisRuns.updatedAt))
    .limit(50)
}

export async function requeueAdminRun(runId: string, adminUserId: string) {
  const [run] = await adminDb
    .select({
      id: analysisRuns.id,
      status: analysisRuns.status,
    })
    .from(analysisRuns)
    .where(eq(analysisRuns.id, runId))
    .limit(1)

  if (!run) return { status: "not_found" as const }
  if (run.status === "queued") return { status: "already_queued" as const }
  if (run.status === "succeeded") return { status: "not_requeued" as const }

  await adminDb
    .update(analysisRuns)
    .set({
      status: "queued",
      stage: "queued",
      progressPct: 0,
      stageDetail: "Requeued by platform admin",
      errorCode: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(analysisRuns.id, runId))

  await enqueueAnalysisRun(runId)
  console.info("admin_run_requeued", { runId, adminUserId })
  return { status: "requeued" as const }
}

export async function markAdminRunFailed(runId: string, adminUserId: string) {
  const [run] = await adminDb
    .select({
      id: analysisRuns.id,
      status: analysisRuns.status,
      updatedAt: analysisRuns.updatedAt,
    })
    .from(analysisRuns)
    .where(eq(analysisRuns.id, runId))
    .limit(1)

  if (!run) return { status: "not_found" as const }
  if (run.status === "failed") return { status: "already_failed" as const }
  if (run.status !== "running" || run.updatedAt > stuckCutoff()) {
    return { status: "not_stuck" as const }
  }

  await adminDb
    .update(analysisRuns)
    .set({
      status: "failed",
      stageDetail: "Marked failed by platform admin watchdog",
      errorCode: "unknown",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(analysisRuns.id, runId))

  console.info("admin_run_marked_failed", { runId, adminUserId })
  return { status: "marked_failed" as const }
}

export async function markStuckRunsFailed(adminUserId: string) {
  const rows = await adminDb
    .update(analysisRuns)
    .set({
      status: "failed",
      stageDetail: "Marked failed by platform admin watchdog",
      errorCode: "unknown",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(adminRunFilterCondition("stuck"))
    .returning({ id: analysisRuns.id })

  console.info("admin_watchdog_marked_failed", {
    count: rows.length,
    adminUserId,
    runIds: rows.map((row) => row.id),
  })
  return rows
}
