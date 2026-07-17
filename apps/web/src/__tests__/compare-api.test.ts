import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "@/app/api/compare/route"

// ── Mocks ─────────────────────────────────────────────────────────────────────

const ORG_ID = "org_compare_route"
const RUN_A = "aa000000-0000-4000-8000-000000000001"
const RUN_B = "bb000000-0000-4000-8000-000000000001"
const VIDEO_A = "aa000000-0000-4000-8000-000000000002"
const VIDEO_B = "bb000000-0000-4000-8000-000000000002"
const TASK_ID = "aa000000-0000-4000-8000-000000000003"

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status = 401
  }

  const selectQueue: unknown[][] = []

  function makeChain(): Record<string, unknown> & PromiseLike<unknown[]> {
    const rows = selectQueue.shift() ?? []
    const chain: Record<string, unknown> & PromiseLike<unknown[]> = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: <T, E>(
        onFulfilled?: ((value: unknown[]) => T | PromiseLike<T>) | null,
        onRejected?: ((reason: unknown) => E | PromiseLike<E>) | null,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    }
    return chain
  }

  const mockDb = {
    select: () => makeChain(),
  }

  return {
    MockUnauthorizedError,
    mockDb,
    selectQueue,
    assembleReportPayload: vi.fn(),
    computeComparison: vi.fn(),
    context: { orgId: "org_compare_route" } as unknown,
  }
})

vi.mock("@/db/client", () => ({ db: mocks.mockDb }))

vi.mock("@/lib/with-org", () => ({
  UnauthorizedError: mocks.MockUnauthorizedError,
  isUnauthorized: (e: unknown) => e instanceof mocks.MockUnauthorizedError,
  withOrg: vi.fn((handler: (ctx: unknown) => unknown) => handler(mocks.context)),
}))

vi.mock("@/lib/report-assembly", () => ({
  assembleReportPayload: mocks.assembleReportPayload,
}))

vi.mock("@/lib/compare", () => ({
  computeComparison: mocks.computeComparison,
}))

// ── Factories ─────────────────────────────────────────────────────────────────

function makeRun(id: string, videoId: string, status = "succeeded") {
  return { id, orgId: ORG_ID, videoId, status }
}

function makeVideo(id: string, taskId: string | null) {
  return {
    id,
    orgId: ORG_ID,
    taskId,
    subjectLabel: null,
    variantLabel: null,
  }
}

function fakePayload(runId: string) {
  return { run: { id: runId }, video: { id: "vid" } }
}

function makeRequest(runParam: string) {
  return new Request(`http://localhost/api/compare?runs=${runParam}`)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/compare", () => {
  beforeEach(() => {
    mocks.selectQueue.length = 0
    mocks.assembleReportPayload.mockReset()
    mocks.computeComparison.mockReturnValue({ score: {}, kinds: [], segments: {} })
  })

  it("returns 400 when runs param is missing", async () => {
    const res = await GET(makeRequest(""))
    expect(res.status).toBe(400)
  })

  it("returns 400 when only one run ID is provided", async () => {
    const res = await GET(makeRequest(RUN_A))
    expect(res.status).toBe(400)
  })

  it("returns 400 when both run IDs are the same", async () => {
    const res = await GET(makeRequest(`${RUN_A},${RUN_A}`))
    expect(res.status).toBe(400)
  })

  it("returns 400 when IDs are not valid UUIDs", async () => {
    const res = await GET(makeRequest("not-a-uuid,also-not-a-uuid"))
    expect(res.status).toBe(400)
  })

  it("returns 404 when a run is not found for this org (org scoping)", async () => {
    // DB returns only one run (the other is from a different org)
    mocks.selectQueue.push([makeRun(RUN_A, VIDEO_A)])
    const res = await GET(makeRequest(`${RUN_A},${RUN_B}`))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not found/i)
  })

  it("returns 400 when runs belong to different tasks", async () => {
    mocks.selectQueue.push([makeRun(RUN_A, VIDEO_A), makeRun(RUN_B, VIDEO_B)])
    // Videos have different task IDs
    mocks.selectQueue.push([
      makeVideo(VIDEO_A, TASK_ID),
      makeVideo(VIDEO_B, "different-task-00000000-0000-4000-8000"),
    ])
    const res = await GET(makeRequest(`${RUN_A},${RUN_B}`))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/same task/i)
  })

  it("returns 400 when a run is queued (not ready)", async () => {
    mocks.selectQueue.push([
      makeRun(RUN_A, VIDEO_A, "queued"),
      makeRun(RUN_B, VIDEO_B, "succeeded"),
    ])
    const res = await GET(makeRequest(`${RUN_A},${RUN_B}`))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/succeeded.*partial/i)
  })

  it("returns 200 with {a, b, comparison} for two valid runs", async () => {
    mocks.selectQueue.push([makeRun(RUN_A, VIDEO_A), makeRun(RUN_B, VIDEO_B)])
    mocks.selectQueue.push([makeVideo(VIDEO_A, TASK_ID), makeVideo(VIDEO_B, TASK_ID)])
    mocks.assembleReportPayload.mockResolvedValueOnce(fakePayload(RUN_A))
    mocks.assembleReportPayload.mockResolvedValueOnce(fakePayload(RUN_B))
    mocks.computeComparison.mockReturnValueOnce({ score: { total: 5 }, kinds: [], segments: {} })

    const res = await GET(makeRequest(`${RUN_A},${RUN_B}`))
    expect(res.status).toBe(200)

    const body = (await res.json()) as { a: unknown; b: unknown; comparison: unknown }
    expect(body.a).toBeDefined()
    expect(body.b).toBeDefined()
    expect(body.comparison).toBeDefined()
  })
})
