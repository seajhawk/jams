import { describe, expect, it, vi, afterEach } from "vitest"

import {
  assertPreviewUserAllowed,
  isPreviewUserAllowed,
  PreviewAccessError,
} from "@/lib/preview-access"
import { resolveOrgContext } from "@/lib/with-org"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("preview access policy", () => {
  it("allows all authenticated users when the policy is unset", () => {
    expect(isPreviewUserAllowed("user_any", undefined)).toBe(true)
  })

  it("denies everyone when the policy is present but empty", () => {
    expect(isPreviewUserAllowed("user_any", "")).toBe(false)
    expect(isPreviewUserAllowed("user_any", " , ")).toBe(false)
  })

  it("denies a missing user ID when preview access is configured", () => {
    expect(isPreviewUserAllowed(null, "user_allowed")).toBe(false)
    expect(isPreviewUserAllowed(undefined, "user_allowed")).toBe(false)
  })

  it("allows only exact comma-separated user IDs", () => {
    expect(isPreviewUserAllowed("user_123", "user_123,user_456")).toBe(true)
    expect(isPreviewUserAllowed("user_12", "user_123,user_456")).toBe(false)
    expect(isPreviewUserAllowed("user_123 ", "user_123,user_456")).toBe(false)
  })

  it("throws a 403 for a denied user", () => {
    expect(() => assertPreviewUserAllowed("user_denied", "user_allowed"))
      .toThrowError(PreviewAccessError)
    try {
      assertPreviewUserAllowed("user_denied", "user_allowed")
    } catch (error) {
      expect(error).toMatchObject({ status: 403 })
    }
  })
})

describe("resolveOrgContext preview enforcement", () => {
  it("rejects before active-org bypass or Clerk/store calls", async () => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_allowed")
    const clerk = {
      organizations: { createOrganization: vi.fn() },
      users: {
        getUser: vi.fn(),
        getOrganizationMembershipList: vi.fn(),
      },
    }
    const store = { upsertOrg: vi.fn() }

    await expect(
      resolveOrgContext({
        authFn: async () => ({
          userId: "user_denied",
          orgId: "org_active",
          sessionClaims: {},
        }),
        clerk,
        store,
      })
    ).rejects.toMatchObject({ status: 403 })

    expect(clerk.organizations.createOrganization).not.toHaveBeenCalled()
    expect(clerk.users.getOrganizationMembershipList).not.toHaveBeenCalled()
    expect(store.upsertOrg).not.toHaveBeenCalled()
  })
})
