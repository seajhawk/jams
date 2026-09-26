// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status = 401
  }
  return { resolveOrgContext: vi.fn(), MockUnauthorizedError }
})

vi.mock("@/lib/with-org", () => ({
  UnauthorizedError: mocks.MockUnauthorizedError,
  isUnauthorized: (error: unknown) => error instanceof mocks.MockUnauthorizedError,
  resolveOrgContext: mocks.resolveOrgContext,
}))

import { GET } from "@/app/api/limits/route"

describe("GET /api/limits", () => {
  beforeEach(() => {
    mocks.resolveOrgContext.mockResolvedValue({ userId: "user_a", orgId: "org_a" })
  })
  afterEach(() => vi.unstubAllEnvs())

  it("returns the configured upload limits for the signed-in workspace", async () => {
    vi.stubEnv("JAMS_LIMIT_UPLOAD_MAX_DURATION_MS", "600000")
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      upload: {
        max_bytes: 2 * 1024 * 1024 * 1024,
        max_duration_ms: 600_000,
        content_types: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"],
      },
    })
  })

  it("requires a session", async () => {
    mocks.resolveOrgContext.mockRejectedValue(new mocks.MockUnauthorizedError())
    expect((await GET()).status).toBe(401)
  })

  it("fails closed on invalid limit configuration", async () => {
    vi.stubEnv("JAMS_LIMIT_UPLOAD_MAX_BYTES", "nope")
    expect((await GET()).status).toBe(503)
  })
})
