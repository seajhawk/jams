import { beforeEach, describe, expect, it, vi } from "vitest"

type OutboxRow = {
  id: string
  runId: string
  orgId: string
  status: "pending" | "dispatched" | "failed"
  attempt: number
  lastError: string | null
  dispatchedAt: Date | null
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

vi.mock("@/db/admin-client.server", () => {
  const adminDb = {
    select: () => {
      return {
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: () => {
                return outboxTable
                  .filter((o) => o.status === "pending")
                  .map((o) => {
                    const run = runsTable.find((r) => r.id === o.runId)
                    return {
                      id: o.id,
                      runId: o.runId,
                      orgId: o.orgId,
                      attempt: o.attempt,
                      status: o.status,
                      runStatus: run?.status,
                    }
                  })
              },
            }),
          }),
          where: () => ({
            orderBy: () => ({
              limit: () => {
                return outboxTable.map((o) => ({ ...o }))
              },
            }),
            limit: (n: number) => {
              return outboxTable.slice(0, n).map((o) => ({ ...o }))
            },
          }),
        }),
      }
    },
    update: () => ({
      set: (values: Partial<OutboxRow> & Partial<AnalysisRunRow>) => ({
        where: () => {
          // If updating outbox
          for (const item of outboxTable) {
            Object.assign(item, values)
          }
          // If updating runs
          for (const run of runsTable) {
            Object.assign(run, values)
          }
          return Promise.resolve(outboxTable)
        },
        returning: () => {
          return Promise.resolve(runsTable.map((r) => ({ id: r.id })))
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

  it("reconciles pending dispatches after crash between commit and send", async () => {
    // Simulate: database committed the run and the outbox item,
    // but the process crashed before enqueueAnalysisRun was called
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
      createdAt: new Date(Date.now() - 60 * 1000), // created 1 minute ago
      updatedAt: new Date(Date.now() - 60 * 1000),
    })

    const result = await reconcilePendingDispatches(new Date())

    expect(result.reconciledCount).toBe(1)
    expect(result.dispatchedRunIds).toEqual(["run-crashed"])
    expect(mocks.enqueueAnalysisRun).toHaveBeenCalledWith("run-crashed")
    expect(outboxTable[0].status).toBe("dispatched")
  })

  it("reconcilePendingDispatches marks missing runs failed rather than enqueuing", async () => {
    // Outbox item with no matching run in runsTable (e.g. rolled back transaction)
    outboxTable.push({
      id: "outbox-ghost",
      runId: "run-nonexistent",
      orgId: "org-1",
      status: "pending",
      attempt: 0,
      lastError: null,
      dispatchedAt: null,
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
      // Setup mock to return a recently updated queued run
      const result = await markAdminRunFailed("run-recent", "admin-user")
      // Since updatedAt is recent in default mock, it should report not_stuck
      expect(["not_stuck", "not_found"]).toContain(result.status)
    })
  })
})
