import { beforeEach, describe, expect, it, vi } from "vitest"

import { POST as reconcile } from "@/app/api/admin/reconcile/route"
import { POST as markFailed } from "@/app/api/admin/runs/[id]/mark-failed/route"
import { POST as requeue } from "@/app/api/admin/runs/[id]/requeue/route"
import { POST as watchdog } from "@/app/api/admin/watchdog/route"
import { HttpError } from "@/lib/api"

const RUN_ID = "8c980f72-91f2-4778-bf2c-57c6f72f9b40"

const mocks = vi.hoisted(() => ({
  markAdminRunFailed: vi.fn(),
  markStuckRunsFailed: vi.fn(),
  requirePlatformAdminApi: vi.fn(),
  requireMachineOrPlatformAdminApi: vi.fn(),
  requeueAdminRun: vi.fn(),
  reconcilePendingDispatches: vi.fn().mockResolvedValue({
    reconciledCount: 0,
    failedCount: 0,
    skippedCount: 0,
    dispatchedRunIds: [],
  }),
}))

vi.mock("@/lib/admin-auth", () => ({
  requirePlatformAdminApi: mocks.requirePlatformAdminApi,
  requireMachineOrPlatformAdminApi: mocks.requireMachineOrPlatformAdminApi,
}))

vi.mock("@/lib/admin-runs", () => ({
  markAdminRunFailed: mocks.markAdminRunFailed,
  markStuckRunsFailed: mocks.markStuckRunsFailed,
  requeueAdminRun: mocks.requeueAdminRun,
  reconcilePendingDispatches: mocks.reconcilePendingDispatches,
}))

function params(id = RUN_ID) {
  return { params: Promise.resolve({ id }) }
}

describe("admin run route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePlatformAdminApi.mockResolvedValue({ userId: "user_admin" })
    mocks.requireMachineOrPlatformAdminApi.mockResolvedValue({
      type: "user",
      userId: "user_admin",
    })
  })

  it("requeues runs through the shared helper", async () => {
    mocks.requeueAdminRun.mockResolvedValue({ status: "requeued" })

    const response = await requeue(
      new Request(`http://jams.test/api/admin/runs/${RUN_ID}/requeue`, {
        method: "POST",
      }),
      params()
    )
    const body = (await response.json()) as { status: string }

    expect(response.status).toBe(200)
    expect(body.status).toBe("requeued")
    expect(mocks.requeueAdminRun).toHaveBeenCalledWith(RUN_ID, "user_admin")
  })

  it("returns not-stuck mark-failed results as conflicts", async () => {
    mocks.markAdminRunFailed.mockResolvedValue({ status: "not_stuck" })

    const response = await markFailed(
      new Request(`http://jams.test/api/admin/runs/${RUN_ID}/mark-failed`, {
        method: "POST",
      }),
      params()
    )

    expect(response.status).toBe(409)
  })

  it("runs watchdog behind the admin gate", async () => {
    mocks.markStuckRunsFailed.mockResolvedValue([{ id: RUN_ID }])

    const request = new Request("http://jams.test/api/admin/watchdog", {
      method: "POST",
    })
    const response = await watchdog(request)
    const body = (await response.json()) as {
      marked_failed: number
      run_ids: string[]
      dispatches_reconciled: number
      dispatched_run_ids: string[]
    }

    expect(response.status).toBe(200)
    expect(body.marked_failed).toBe(1)
    expect(body.run_ids).toEqual([RUN_ID])
    expect(mocks.requireMachineOrPlatformAdminApi).toHaveBeenCalledWith(request)
    expect(mocks.reconcilePendingDispatches).toHaveBeenCalled()
  })

  it("runs reconcile behind the admin gate", async () => {
    mocks.reconcilePendingDispatches.mockResolvedValue({
      reconciledCount: 1,
      failedCount: 0,
      skippedCount: 0,
      dispatchedRunIds: [RUN_ID],
    })

    const request = new Request("http://jams.test/api/admin/reconcile", {
      method: "POST",
    })
    const response = await reconcile(request)
    const body = (await response.json()) as {
      reconciled_count: number
      failed_count: number
      skipped_count: number
      dispatched_run_ids: string[]
    }

    expect(response.status).toBe(200)
    expect(body.reconciled_count).toBe(1)
    expect(body.dispatched_run_ids).toEqual([RUN_ID])
    expect(mocks.requireMachineOrPlatformAdminApi).toHaveBeenCalledWith(request)
  })

  it("404s non-admin callers before running actions", async () => {
    mocks.requirePlatformAdminApi.mockRejectedValue(new HttpError(404, "Not found"))

    const response = await requeue(
      new Request(`http://jams.test/api/admin/runs/${RUN_ID}/requeue`, {
        method: "POST",
      }),
      params()
    )

    expect(response.status).toBe(404)
    expect(mocks.requeueAdminRun).not.toHaveBeenCalled()
  })
})
