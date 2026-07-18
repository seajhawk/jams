import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { HttpError } from "@/lib/api"
import {
  isAdminUserId,
  parseAdminUserIds,
  requirePlatformAdminApi,
} from "@/lib/admin-auth"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}))

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}))

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

const originalAdminUserIds = process.env.ADMIN_USER_IDS

describe("platform admin allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.ADMIN_USER_IDS = originalAdminUserIds
  })

  it("parses comma-separated Clerk user ids", () => {
    expect(parseAdminUserIds("user_a, user_b,,")).toEqual(
      new Set(["user_a", "user_b"])
    )
    expect(isAdminUserId("user_a", parseAdminUserIds("user_a"))).toBe(true)
  })

  it("returns 404 for a signed-in non-allowlisted user", async () => {
    process.env.ADMIN_USER_IDS = "user_admin"
    mocks.auth.mockResolvedValue({ userId: "user_member" })

    await expect(requirePlatformAdminApi()).rejects.toMatchObject({
      status: 404,
      message: "Not found",
    } satisfies Partial<HttpError>)
  })
})
