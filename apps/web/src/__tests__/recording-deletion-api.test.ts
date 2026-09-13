import { beforeEach, describe, expect, it, vi } from "vitest"
import { DELETE } from "@/app/api/videos/[id]/route"
import { HttpError } from "@/lib/api"

const mocks = vi.hoisted(() => ({
  request: vi.fn(), cleanup: vi.fn(), authError: null as Error | null,
  committed: false, scopedDb: { orgId: "server_org" },
}))
vi.mock("@/lib/recording-deletion", () => ({ requestRecordingDeletion: mocks.request }))
vi.mock("@/lib/recording-cleanup", () => ({ reconcileRecordingCleanup: mocks.cleanup }))
vi.mock("@/lib/with-org", async (original) => ({
  ...await original<typeof import("@/lib/with-org")>(),
  withOrg: async (fn: (context: unknown) => unknown) => {
    if (mocks.authError) throw mocks.authError
    const result = await fn({ scopedDb: mocks.scopedDb })
    mocks.committed = true
    return result
  },
}))
const id = "c314c2af-541d-445a-8f62-86219d5c73ed"
const call = (videoId = id) => DELETE(new Request(`http://jams.test/api/videos/${videoId}`, {
  method: "DELETE", body: JSON.stringify({ org_id: "forged_org" }),
}), { params: Promise.resolve({ id: videoId }) })

describe("recording deletion endpoint", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.authError = null
    mocks.committed = false
    mocks.request.mockResolvedValue({ videoId: id })
    mocks.cleanup.mockImplementation(async () => { expect(mocks.committed).toBe(true) })
  })
  it("commits tenant revocation before cleanup and ignores supplied org identity", async () => {
    const response = await call()
    expect(response.status).toBe(202)
    expect(mocks.request).toHaveBeenCalledWith(mocks.scopedDb, id)
    expect(mocks.cleanup).toHaveBeenCalledWith(id)
  })
  it("accepts durable deletion even when the immediate cleanup attempt fails", async () => {
    mocks.cleanup.mockRejectedValue(new Error("temporary failure"))
    expect((await call()).status).toBe(202)
  })
  it("does not start cleanup on tenant lookup failure", async () => {
    mocks.request.mockRejectedValue(new HttpError(404, "Not found"))
    expect((await call()).status).toBe(404)
    expect(mocks.cleanup).not.toHaveBeenCalled()
  })
  it("returns a retryable conflict when a storage write holds the deletion lock", async () => {
    mocks.request.mockRejectedValue(new Error("query failed", { cause: { code: "55P03" } }))
    expect((await call()).status).toBe(409)
    expect(mocks.cleanup).not.toHaveBeenCalled()
  })
  it("requires authentication before tenant mutation", async () => {
    mocks.authError = new HttpError(401, "Authentication required")
    expect((await call()).status).toBe(401)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it("rejects malformed ids before mutation", async () => {
    expect((await call("not-an-id")).status).toBe(404)
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
