import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { HttpError } from "@/lib/api"
import {
  isAdminUserId,
  parseAdminUserIds,
  requireMachineOrPlatformAdminApi,
  requirePlatformAdminApi,
  verifyMachineSecret,
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
const originalWatchdogSecret = process.env.WATCHDOG_SECRET

describe("platform admin allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.ADMIN_USER_IDS = originalAdminUserIds
    process.env.WATCHDOG_SECRET = originalWatchdogSecret
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

  describe("machine authentication and secret verification", () => {
    it("verifies matching secrets with timing-safe comparison", () => {
      expect(verifyMachineSecret("secret123", "secret123")).toBe(true)
      expect(verifyMachineSecret("wrong", "secret123")).toBe(false)
      expect(verifyMachineSecret("", "secret123")).toBe(false)
      expect(verifyMachineSecret(undefined, "secret123")).toBe(false)
      expect(verifyMachineSecret("secret123", "")).toBe(false)
    })

    it("authenticates machine requests with Bearer token header", async () => {
      process.env.WATCHDOG_SECRET = "super-secret-token"

      const request = new Request("http://jams.test/api/admin/watchdog", {
        method: "POST",
        headers: {
          authorization: "Bearer super-secret-token",
        },
      })

      const result = await requireMachineOrPlatformAdminApi(request)
      expect(result).toEqual({
        type: "machine",
        userId: "system:watchdog",
      })
      expect(mocks.auth).not.toHaveBeenCalled()
    })

    it("authenticates machine requests with x-watchdog-secret header", async () => {
      process.env.WATCHDOG_SECRET = "super-secret-token"

      const request = new Request("http://jams.test/api/admin/reconcile", {
        method: "POST",
        headers: {
          "x-watchdog-secret": "super-secret-token",
        },
      })

      const result = await requireMachineOrPlatformAdminApi(request)
      expect(result).toEqual({
        type: "machine",
        userId: "system:watchdog",
      })
    })

    it("falls back to platform admin user if no machine secret is provided", async () => {
      process.env.ADMIN_USER_IDS = "user_admin"
      process.env.WATCHDOG_SECRET = "super-secret-token"
      mocks.auth.mockResolvedValue({ userId: "user_admin" })

      const request = new Request("http://jams.test/api/admin/watchdog", {
        method: "POST",
      })

      const result = await requireMachineOrPlatformAdminApi(request)
      expect(result).toEqual({
        type: "user",
        userId: "user_admin",
      })
    })

    it("returns 404 if machine secret is invalid and user is not admin", async () => {
      process.env.ADMIN_USER_IDS = "user_admin"
      process.env.WATCHDOG_SECRET = "super-secret-token"
      mocks.auth.mockResolvedValue({ userId: "user_member" })

      const request = new Request("http://jams.test/api/admin/watchdog", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
        },
      })

      await expect(requireMachineOrPlatformAdminApi(request)).rejects.toMatchObject({
        status: 404,
        message: "Not found",
      } satisfies Partial<HttpError>)
    })
  })
})
