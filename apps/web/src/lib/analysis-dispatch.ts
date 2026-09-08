import { and, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm"

import { adminDb } from "@/db/admin-client.server"
import { analysisDispatchOutbox, analysisRuns } from "@/db/schema"
import { enqueueAnalysisRun } from "@/lib/queue"
import type { ScopedDbClient } from "@/lib/with-org"

export const DEFAULT_DISPATCH_LEASE_MS = 30 * 1000

export class DispatchConsistencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DispatchConsistencyError"
  }
}

export type RecordDispatchIntentInput = {
  runId: string
  orgId: string
}

export type DispatchRunOptions = {
  runId: string
  outboxId?: string
  leaseDurationMs?: number
}

export type DispatchRunResult = {
  dispatched: boolean
  alreadyDispatched?: boolean
  concurrentClaim?: boolean
  error?: string
}

export type ReconcileDispatchesOptions = {
  cutoffDate?: Date
  leaseDurationMs?: number
  now?: Date
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
 * Atomically acquires a lease before sending so concurrent instances do not duplicate.
 */
export async function dispatchAnalysisRun(
  options: DispatchRunOptions
): Promise<DispatchRunResult> {
  const { runId, outboxId, leaseDurationMs = DEFAULT_DISPATCH_LEASE_MS } = options

  const [outbox] = outboxId
    ? await adminDb
        .select()
        .from(analysisDispatchOutbox)
        .where(eq(analysisDispatchOutbox.id, outboxId))
        .limit(1)
    : await adminDb
        .select()
        .from(analysisDispatchOutbox)
        .where(eq(analysisDispatchOutbox.runId, runId))
        .orderBy(desc(analysisDispatchOutbox.createdAt))
        .limit(1)

  if (!outbox) {
    throw new DispatchConsistencyError(
      `Durable dispatch invariant violation: no outbox record found for run ${runId}`
    )
  }

  if (outbox.status === "dispatched") {
    return { dispatched: false, alreadyDispatched: true }
  }

  if (outbox.status === "failed") {
    return { dispatched: false, error: outbox.lastError ?? "Outbox marked failed" }
  }

  // Atomically claim/lease the pending outbox row
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs)

  const [claimed] = await adminDb
    .update(analysisDispatchOutbox)
    .set({
      leaseExpiresAt,
      attempt: sql`${analysisDispatchOutbox.attempt} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(analysisDispatchOutbox.id, outbox.id),
        eq(analysisDispatchOutbox.status, "pending"),
        or(
          isNull(analysisDispatchOutbox.leaseExpiresAt),
          lte(analysisDispatchOutbox.leaseExpiresAt, now)
        )
      )
    )
    .returning()

  if (!claimed) {
    // Another concurrent worker/route acquired the lease or dispatched
    return { dispatched: false, concurrentClaim: true }
  }

  try {
    await enqueueAnalysisRun(runId)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await adminDb
      .update(analysisDispatchOutbox)
      .set({
        lastError: errorMessage,
        leaseExpiresAt: null, // Clear lease so it can be retried immediately
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
      leaseExpiresAt: null,
      updatedAt: new Date(),
      lastError: null,
    })
    .where(eq(analysisDispatchOutbox.id, outbox.id))

  return { dispatched: true }
}

/**
 * Reconciles pending outbox records that were committed but not yet dispatched,
 * e.g. after a process crash between database commit and queue send.
 * Recovers expired / stale leases safely.
 */
export async function reconcilePendingDispatches(
  options?: ReconcileDispatchesOptions | Date
): Promise<ReconcileDispatchesResult> {
  const opts: ReconcileDispatchesOptions =
    options instanceof Date ? { cutoffDate: options } : options ?? {}

  const currentTime = opts.now ?? new Date()
  const cutoff = opts.cutoffDate ?? new Date(currentTime.getTime() - 15 * 1000)
  const leaseDurationMs = opts.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_MS

  const pendingItems = await adminDb
    .select({
      id: analysisDispatchOutbox.id,
      runId: analysisDispatchOutbox.runId,
      orgId: analysisDispatchOutbox.orgId,
      attempt: analysisDispatchOutbox.attempt,
      status: analysisDispatchOutbox.status,
      leaseExpiresAt: analysisDispatchOutbox.leaseExpiresAt,
      createdAt: analysisDispatchOutbox.createdAt,
      runStatus: analysisRuns.status,
    })
    .from(analysisDispatchOutbox)
    .leftJoin(analysisRuns, eq(analysisDispatchOutbox.runId, analysisRuns.id))
    .where(
      and(
        eq(analysisDispatchOutbox.status, "pending"),
        or(
          isNull(analysisDispatchOutbox.leaseExpiresAt),
          lte(analysisDispatchOutbox.leaseExpiresAt, currentTime)
        ),
        or(
          lte(analysisDispatchOutbox.createdAt, cutoff),
          and(
            isNotNull(analysisDispatchOutbox.leaseExpiresAt),
            lte(analysisDispatchOutbox.leaseExpiresAt, currentTime)
          )
        )
      )
    )
    .limit(50)

  let reconciledCount = 0
  let failedCount = 0
  let skippedCount = 0
  const dispatchedRunIds: string[] = []

  for (const item of pendingItems) {
    // Atomically claim the lease
    const claimTime = new Date()
    const leaseExpires = new Date(claimTime.getTime() + leaseDurationMs)

    const [claimed] = await adminDb
      .update(analysisDispatchOutbox)
      .set({
        leaseExpiresAt: leaseExpires,
        attempt: sql`${analysisDispatchOutbox.attempt} + 1`,
        updatedAt: claimTime,
      })
      .where(
        and(
          eq(analysisDispatchOutbox.id, item.id),
          eq(analysisDispatchOutbox.status, "pending"),
          or(
            isNull(analysisDispatchOutbox.leaseExpiresAt),
            lte(analysisDispatchOutbox.leaseExpiresAt, claimTime)
          )
        )
      )
      .returning()

    if (!claimed) {
      skippedCount++
      continue
    }

    if (!item.runStatus) {
      // Run does not exist in DB (e.g. rolled back transaction)
      await adminDb
        .update(analysisDispatchOutbox)
        .set({
          status: "failed",
          leaseExpiresAt: null,
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
          leaseExpiresAt: null,
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
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
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
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(analysisDispatchOutbox.id, item.id))
      reconciledCount++
      dispatchedRunIds.push(item.runId)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await adminDb
        .update(analysisDispatchOutbox)
        .set({
          lastError: errorMessage,
          leaseExpiresAt: null,
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
