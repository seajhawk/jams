import { describe, expect, it } from "vitest"

import { resolveOrgContext, UnauthorizedError } from "@/lib/with-org"
import type { ClerkBackendClient, ClerkOrg } from "@/lib/clerk/types"

function fakeStore() {
  const orgs: ClerkOrg[] = []
  return {
    orgs,
    async upsertOrg(org: ClerkOrg) {
      orgs.push(org)
    },
  }
}

function fakeClerk(memberships: ClerkOrg[]): ClerkBackendClient {
  return {
    organizations: {
      async createOrganization(input) {
        return {
          id: "org_created",
          name: input.name,
          privateMetadata: input.privateMetadata,
        }
      },
    },
    users: {
      async getUser(userId) {
        return { id: userId, fullName: "Chris Test" }
      },
      async getOrganizationMembershipList() {
        return {
          data: memberships.map((organization) => ({ organization })),
        }
      },
    },
  }
}

describe("withOrg context resolution", () => {
  it("rejects requests without a signed-in user", async () => {
    await expect(
      resolveOrgContext({
        authFn: async () => ({
          userId: null,
          orgId: null,
          sessionClaims: null,
        }),
      })
    ).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it("uses the active org claim when present", async () => {
    const context = await resolveOrgContext({
      authFn: async () => ({
        userId: "user_123",
        orgId: "org_active",
        sessionClaims: { name: "Chris Test" },
      }),
      clerk: fakeClerk([]),
    })

    expect(context.userId).toBe("user_123")
    expect(context.orgId).toBe("org_active")
  })

  it("falls back to an existing hidden personal org", async () => {
    const store = fakeStore()
    const context = await resolveOrgContext({
      authFn: async () => ({
        userId: "user_123",
        orgId: null,
        sessionClaims: { name: "Chris Test" },
      }),
      clerk: fakeClerk([
        {
          id: "org_personal",
          name: "Chris Test's workspace",
          privateMetadata: { personal: true },
        },
      ]),
      store,
    })

    expect(context.orgId).toBe("org_personal")
    expect(store.orgs).toHaveLength(1)
  })

  it("creates a hidden personal org when none exists", async () => {
    const store = fakeStore()
    const context = await resolveOrgContext({
      authFn: async () => ({
        userId: "user_123",
        orgId: null,
        sessionClaims: { name: "Chris Test" },
      }),
      clerk: fakeClerk([]),
      store,
    })

    expect(context.orgId).toBe("org_created")
    expect(store.orgs[0]).toMatchObject({
      id: "org_created",
      name: "Chris Test's workspace",
      privateMetadata: { personal: true },
    })
  })
})
