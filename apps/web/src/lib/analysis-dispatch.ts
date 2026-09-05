import { and, desc, eq, lte } from "drizzle-orm"

import { adminDb } from "@/db/admin-client.server"
import { analysisDispatchOutbox, analysisRuns } from "@/db/schema"
import { enqueueAnalysisRun } from "@/lib/queue"
import type { ScopedDbClient } from "@/lib/with-org"

export type RecordDispatchIntentInput = {
  runId: string
  orgId: string
}

export type DispatchRunOptions = {
  runId: string
  outboxId?: string
}

export type DispatchRunResult = {
  dispatched: boolean
  alreadyDispatched?: boolean
  error?: string
}

export type ReconcileDispatchesResult = {
  reconciledCount: number
  failedCount: number
  skippedCount: number
  dispatchedRunIds: string[]
}

/**
 * Inserts a durable dispatch-intent / outbox entry within the caller's transaction.
 * Must be committed alongside the analysis run to guarantee visibility.
 */
export async function recordDispatchIntent(
  tx: ScopedDbClient,
  input: RecordDispatchIntentInput
) {
  const [row] = await tx
    .insert(analysisDispatchOutbox)
    .values({
      runId: input.runId,
      orgId: input.orgId,
      status: "pending",
    })
    .returning()

  return row
}

/**
 * Attempts to dispatch an analysis run by publishing to the queue and
 * marking the outbox entry as dispatched.
 * Must be called outside the database transaction (after commit).
 */
export async function dispatchAnalysisRun(
  options: DispatchRunOptions
): Promise<DispatchRunResult> {
  const { runId, outboxId } = options

  const [outbox] = outboxId
    ? await adminDb
        .select()
        .from(analysisDispatchOutbox)
        .where(eq(analysisDispatchOutbox.id, outboxId))
        .limit(1)
    : await adminDb
        .select()
        .from(analysisDispatchOutbox)
        .where(
          and(
            eq(analysisDispatchOutbox.runId, runId),
            eq(analysisDispatchOutbox.status, "pending")
          )
        )
        .orderBy(desc(analysisDispatchOutbox.createdAt))
        .limit(1)

  if (!outbox) {
    // Check if it was already dispatched
    const [existing] = await adminDb
      .select({ id: analysisDispatchOutbox.id, status: analysisDispatchOutbox.status })
      .from(analysisDispatchOutbox)
      .where(eq(analysisDispatchOutbox.runId, runId))
      .orderBy(desc(analysisDispatchOutbox.createdAt))
      .limit(1)

    if (existing?.status === "dispatched") {
      return { dispatched: false, alreadyDispatched: true }
    }

    // Direct dispatch without an outbox record (fallback)
    await enqueueAnalysisRun(runId)
    return { dispatched: true }
  }

  if (outbox.status === "dispatched") {
    return { dispatched: false, alreadyDispatched: true }
  }

  try {
    await enqueueAnalysisRun(runId)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await adminDb
      .update(analysisDispatchOutbox)
      .set({
        attempt: outbox.attempt + 1,
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(analysisDispatchOutbox.id, outbox.id))

    return { dispatched: false, error: errorMessage }
  }

  await adminDb
    .update(analysisDispatchOutbox)
    .set({
      status: "dispatched",
      dispatchedAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
    })
    .where(eq(analysisDispatchOutbox.id, outbox.id))

  return { dispatched: true }
}

/**
 * Reconciles pending outbox records that were committed but not yet dispatched,
 * e.g. after a process crash between database commit and queue send.
 */
export async function reconcilePendingDispatches(
  cutoffDate?: Date
): Promise<ReconcileDispatchesResult> {
  const cutoff = cutoffDate ?? new Date(Date.now() - 15 * 1000)

  const pendingItems = await adminDb
    .select({
      id: analysisDispatchOutbox.id,
      runId: analysisDispatchOutbox.runId,
      orgId: analysisDispatchOutbox.orgId,
      attempt: analysisDispatchOutbox.attempt,
      status: analysisDispatchOutbox.status,
      runStatus: analysisRuns.status,
    })
    .from(analysisDispatchOutbox)
    .leftJoin(analysisRuns, eq(analysisDispatchOutbox.runId, analysisRuns.id))
    .where(
      and(
        eq(analysisDispatchOutbox.status, "pending"),
        lte(analysisDispatchOutbox.createdAt, cutoff)
      )
    )
    .limit(50)

  let reconciledCount = 0
  let failedCount = 0
  let skippedCount = 0
  const dispatchedRunIds: string[] = []

  for (const item of pendingItems) {
    if (!item.runStatus) {
      // Run does not exist in DB (e.g. rolled back transaction)
      await adminDb
        .update(analysisDispatchOutbox)
        .set({
          status: "failed",
          lastError: "Associated analysis run does not exist",
          updatedAt: new Date(),
        })
        .where(eq(analysisDispatchOutbox.id, item.id))
      failedCount++
      continue
    }

    if (
      item.runStatus === "succeeded" ||
      item.runStatus === "failed" ||
      item.runStatus === "partial"
    ) {
      // Run is already completed
      await adminDb
        .update(analysisDispatchOutbox)
        .set({
          status: "dispatched",
          lastError: `Run already in terminal status ${item.runStatus}`,
          updatedAt: new Date(),
        })
        .where(eq(analysisDispatchOutbox.id, item.id))
      skippedCount++
      continue
    }

    if (item.runStatus === "running") {
      // Run is already in progress with worker
      await adminDb
        .update(analysisDispatchOutbox)
        .set({
          status: "dispatched",
          dispatchedAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
        })
        .where(eq(analysisDispatchOutbox.id, item.id))
      skippedCount++
      continue
    }

    // Run is queued, dispatch it
    try {
      await enqueueAnalysisRun(item.runId)
      await adminDb
        .update(analysisDispatchOutbox)
        .set({
          status: "dispatched",
          dispatchedAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
        })
        .where(eq(analysisDispatchOutbox.id, item.id))
      reconciledCount++
      dispatchedRunIds.push(item.runId)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await adminDb
        .update(analysisDispatchOutbox)
        .set({
          attempt: item.attempt + 1,
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(analysisDispatchOutbox.id, item.id))
      failedCount++
    }
  }

  return {
    reconciledCount,
    failedCount,
    skippedCount,
    dispatchedRunIds,
  }
}
