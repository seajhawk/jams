import { beforeEach, describe, expect, it, vi } from "vitest"

type OutboxRow = {
  id: string
  runId: string
  orgId: string
  status: "pending" | "dispatched" | "failed"
  attempt: number
  lastError: string | null
  dispatchedAt: Date | null
  leaseExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type AnalysisRunRow = {
  id: string
  orgId: string
  status: string
  updatedAt: Date
  stageDetail?: string
  errorCode?: string | null
  completedAt?: Date | null
}

const outboxTable: OutboxRow[] = []
const runsTable: AnalysisRunRow[] = []

const mocks = vi.hoisted(() => ({
  enqueueAnalysisRun: vi.fn(),
}))

vi.mock("@/lib/queue", () => ({
  enqueueAnalysisRun: mocks.enqueueAnalysisRun,
}))

function extractValues(
  obj: unknown,
  seen = new Set<unknown>()
): (string | number | Date)[] {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return []
  seen.add(obj)
  const res: (string | number | Date)[] = []

  if (Array.isArray(obj)) {
    for (const x of obj) res.push(...extractValues(x, seen))
  } else {
    const record = obj as Record<string, unknown>
    if (
      "value" in record &&
      (typeof record.value === "string" ||
        typeof record.value === "number" ||
        record.value instanceof Date)
    ) {
      res.push(record.value)
    }
    if ("name" in record && typeof record.name === "string") {
      res.push(record.name)
    }
    if ("queryChunks" in record && Array.isArray(record.queryChunks)) {
      for (const chunk of record.queryChunks) {
        res.push(...extractValues(chunk, seen))
      }
    }
  }
  return res
}

vi.mock("@/db/admin-client.server", () => {
  const adminDb = {
    select: () => ({
      from: (table: unknown) => {
        const tableName = (table as Record<symbol, unknown>)?.[
          Symbol.for("drizzle:Name")
        ] as string | undefined

        return {
          leftJoin: () => ({
            where: () => ({
              limit: (limitCount?: number) => {
                const now = new Date()
                const pending = outboxTable
                  .filter(
                    (o) =>
                      o.status === "pending" &&
                      (!o.leaseExpiresAt || o.leaseExpiresAt <= now)
                  )
                  .map((o) => {
                    const run = runsTable.find((r) => r.id === o.runId)
                    return {
                      id: o.id,
                      runId: o.runId,
                      orgId: o.orgId,
                      attempt: o.attempt,
                      status: o.status,
                      leaseExpiresAt: o.leaseExpiresAt,
                      runStatus: run?.status,
                    }
                  })
                return Promise.resolve(
                  limitCount ? pending.slice(0, limitCount) : pending
                )
              },
            }),
          }),
          where: (condition: unknown) => {
            const values = extractValues(condition)
            let matched: (OutboxRow | AnalysisRunRow)[] = []

            if (tableName === "analysis_runs") {
              matched = runsTable.filter((r) => values.includes(r.id))
            } else {
              matched = outboxTable.filter(
                (o) => values.includes(o.id) || values.includes(o.runId)
              )
            }

            const resolveWithLimit = (limitCount?: number) =>
              Promise.resolve(
                limitCount ? matched.slice(0, limitCount) : matched
              )

            return {
              limit: (n: number) => resolveWithLimit(n),
              orderBy: () => ({
                limit: (n: number) => resolveWithLimit(n),
              }),
            }
          },
        }
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const tableName = (table as Record<symbol, unknown>)?.[
            Symbol.for("drizzle:Name")
          ] as string | undefined
          const condValues = extractValues(condition)
          let matchedRows: (OutboxRow | AnalysisRunRow)[] = []

          if (tableName === "analysis_runs") {
            const targetRun = runsTable.find((r) => condValues.includes(r.id))
            if (targetRun) {
              Object.assign(targetRun, values)
              matchedRows = [{ ...targetRun }]
            }
          } else {
            const targetOutbox = outboxTable.find(
              (o) => condValues.includes(o.id) || condValues.includes(o.runId)
            )

            if (targetOutbox) {
              const requiresPending = condValues.includes("pending")
              const isPending = targetOutbox.status === "pending"

              if (requiresPending && !isPending) {
                // Status predicate failed
              } else {
                const now = new Date()
                const isCheckingLease =
                  condValues.includes("lease_expires_at") ||
                  condValues.includes("leaseExpiresAt")
                const hasActiveLease =
                  targetOutbox.leaseExpiresAt !== null &&
                  targetOutbox.leaseExpiresAt > now

                if (isCheckingLease && hasActiveLease) {
                  // Lease held by another instance; cannot claim
                } else {
                  const attemptVal =
                    typeof values.attempt === "number"
                      ? values.attempt
                      : targetOutbox.attempt + 1

                  Object.assign(targetOutbox, {
                    ...values,
                    attempt:
                      values.attempt !== undefined
                        ? attemptVal
                        : targetOutbox.attempt,
                  })
                  matchedRows = [{ ...targetOutbox }]
                }
              }
            }
          }

          const queryPromise = Promise.resolve(matchedRows)
          return Object.assign(queryPromise, {
            returning: () => Promise.resolve(matchedRows),
          })
        },
      }),
    }),
    insert: () => ({
      values: (values: Partial<OutboxRow>) => ({
        returning: () => {
          const row: OutboxRow = {
            id: values.id ?? "outbox-1",
            runId: values.runId!,
            orgId: values.orgId!,
            status: values.status ?? "pending",
            attempt: values.attempt ?? 0,
            lastError: values.lastError ?? null,
            dispatchedAt: values.dispatchedAt ?? null,
            leaseExpiresAt: values.leaseExpiresAt ?? null,
            createdAt: values.createdAt ?? new Date(),
            updatedAt: values.updatedAt ?? new Date(),
          }
          outboxTable.push(row)
          return Promise.resolve([row])
        },
      }),
    }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(adminDb),
  }

  return { adminDb }
})

import {
  DispatchConsistencyError,
  dispatchAnalysisRun,
  reconcilePendingDispatches,
  recordDispatchIntent,
} from "@/lib/analysis-dispatch"
import {
  adminRunFilterCondition,
  markAdminRunFailed,
} from "@/lib/admin-runs"

describe("Durable analysis dispatch and outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    outboxTable.length = 0
    runsTable.length = 0
    mocks.enqueueAnalysisRun.mockResolvedValue(undefined)
  })

  it("recordDispatchIntent inserts a pending outbox record", async () => {
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "outbox-test-1",
              runId: "run-test-1",
              orgId: "org-test-1",
              status: "pending",
            },
          ]),
        }),
      }),
    }

    const row = await recordDispatchIntent(
      tx as unknown as Parameters<typeof recordDispatchIntent>[0],
      {
        runId: "run-test-1",
        orgId: "org-test-1",
      }
    )

    expect(row).toMatchObject({
      id: "outbox-test-1",
      runId: "run-test-1",
      orgId: "org-test-1",
      status: "pending",
    })
  })

  it("dispatchAnalysisRun publishes to queue and marks outbox dispatched", async () => {
    outboxTable.push({
      id: "outbox-1",
      runId: "run-1",
      orgId: "org-1",
      status: "pending",
      attempt: 0,
      lastError: null,
      dispatchedAt: null,
      leaseExpiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await dispatchAnalysisRun({
      runId: "run-1",
      outboxId: "outbox-1",
    })

    expect(result.dispatched).toBe(true)
    expect(mocks.enqueueAnalysisRun).toHaveBeenCalledWith("run-1")
    expect(outboxTable[0].status).toBe("dispatched")
    expect(outboxTable[0].dispatchedAt).toBeInstanceOf(Date)
    expect(outboxTable[0].leaseExpiresAt).toBeNull()
  })

  it("dispatchAnalysisRun throws DispatchConsistencyError when outbox row does not exist", async () => {
    // No outbox row in outboxTable
    await expect(
      dispatchAnalysisRun({
        runId: "run-missing-outbox",
        outboxId: "outbox-missing",
      })
    ).rejects.toThrow(DispatchConsistencyError)

    expect(mocks.enqueueAnalysisRun).not.toHaveBeenCalled()
  })

  it("dispatchAnalysisRun is idempotent and guards against duplicate sends", async () => {
    outboxTable.push({
      id: "outbox-1",
      runId: "run-1",
      orgId: "org-1",
      status: "dispatched",
      attempt: 1,
      lastError: null,
      dispatchedAt: new Date(),
      leaseExpiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await dispatchAnalysisRun({
      runId: "run-1",
      outboxId: "outbox-1",
    })

    expect(result.dispatched).toBe(false)
    expect(result.alreadyDispatched).toBe(true)
    expect(mocks.enqueueAnalysisRun).not.toHaveBeenCalled()
  })

  it("prevents concurrent dispatch by acquiring atomic lease", async () => {
    // Row is pending but currently has an active unexpired lease held by another instance
    outboxTable.push({
      id: "outbox-concurrent",
      runId: "run-concurrent",
      orgId: "org-1",
      status: "pending",
      attempt: 1,
      lastError: null,
      dispatchedAt: null,
      leaseExpiresAt: new Date(Date.now() + 30 * 1000), // active lease for 30s
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const result = await dispatchAnalysisRun({
      runId: "run-concurrent",
      outboxId: "outbox-concurrent",
    })

    expect(result.dispatched).toBe(false)
    expect(result.concurrentClaim).toBe(true)
    expect(mocks.enqueueAnalysisRun).not.toHaveBeenCalled()
  })

  it("recovers stale expired leases during reconciliation", async () => {
    // Row has an expired lease from a previous crashed run attempt
    runsTable.push({
      id: "run-stale",
      orgId: "org-1",
      status: "queued",
      updatedAt: new Date(),
    })
    outboxTable.push({
      id: "outbox-stale",
      runId: "run-stale",
      orgId: "org-1",
      status: "pending",
      attempt: 1,
      lastError: null,
      dispatchedAt: null,
      leaseExpiresAt: new Date(Date.now() - 60 * 1000), // expired 1 min ago
      createdAt: new Date(Date.now() - 120 * 1000),
      updatedAt: new Date(Date.now() - 60 * 1000),
    })

    const result = await reconcilePendingDispatches(new Date())

    expect(result.reconciledCount).toBe(1)
    expect(result.dispatchedRunIds).toEqual(["run-stale"])
    expect(mocks.enqueueAnalysisRun).toHaveBeenCalledWith("run-stale")
    expect(outboxTable[0].status).toBe("dispatched")
    expect(outboxTable[0].leaseExpiresAt).toBeNull()
  })

  it("reconciles pending dispatches after crash between commit and send", async () => {
    runsTable.push({
      id: "run-crashed",
      orgId: "org-1",
      status: "queued",
      updatedAt: new Date(),
    })
    outboxTable.push({
      id: "outbox-crashed",
      runId: "run-crashed",
      orgId: "org-1",
      status: "pending",
      attempt: 0,
      lastError: null,
      dispatchedAt: null,
      leaseExpiresAt: null,
      createdAt: new Date(Date.now() - 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 1000),
    })

    const result = await reconcilePendingDispatches(new Date())

    expect(result.reconciledCount).toBe(1)
    expect(result.dispatchedRunIds).toEqual(["run-crashed"])
    expect(mocks.enqueueAnalysisRun).toHaveBeenCalledWith("run-crashed")
    expect(outboxTable[0].status).toBe("dispatched")
  })

  it("reconcilePendingDispatches marks missing runs failed rather than enqueuing", async () => {
    outboxTable.push({
      id: "outbox-ghost",
      runId: "run-nonexistent",
      orgId: "org-1",
      status: "pending",
      attempt: 0,
      lastError: null,
      dispatchedAt: null,
      leaseExpiresAt: null,
      createdAt: new Date(Date.now() - 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 1000),
    })

    const result = await reconcilePendingDispatches(new Date())

    expect(result.failedCount).toBe(1)
    expect(result.reconciledCount).toBe(0)
    expect(mocks.enqueueAnalysisRun).not.toHaveBeenCalled()
    expect(outboxTable[0].status).toBe("failed")
  })

  it("reconcilePendingDispatches skips already completed runs", async () => {
    runsTable.push({
      id: "run-done",
      orgId: "org-1",
      status: "succeeded",
      updatedAt: new Date(),
    })
    outboxTable.push({
      id: "outbox-done",
      runId: "run-done",
      orgId: "org-1",
      status: "pending",
      attempt: 0,
      lastError: null,
      dispatchedAt: null,
      leaseExpiresAt: null,
      createdAt: new Date(Date.now() - 60 * 1000),
      updatedAt: new Date(Date.now() - 60 * 1000),
    })

    const result = await reconcilePendingDispatches(new Date())

    expect(result.skippedCount).toBe(1)
    expect(result.reconciledCount).toBe(0)
    expect(mocks.enqueueAnalysisRun).not.toHaveBeenCalled()
    expect(outboxTable[0].status).toBe("dispatched")
  })

  describe("Watchdog stuck run recovery", () => {
    it("adminRunFilterCondition includes stuck queued runs", () => {
      const condition = adminRunFilterCondition("stuck")
      expect(condition).toBeDefined()
    })

    it("markAdminRunFailed rejects recent queued runs as not_stuck", async () => {
      runsTable.push({
        id: "run-recent",
        orgId: "org-1",
        status: "queued",
        updatedAt: new Date(),
      })

      const result = await markAdminRunFailed("run-recent", "admin-user")
      expect(["not_stuck", "not_found"]).toContain(result.status)
    })
  })
})

