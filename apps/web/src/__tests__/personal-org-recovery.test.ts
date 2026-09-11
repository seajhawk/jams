import { describe, expect, it, vi } from "vitest"

import { reconcilePersonalOrganization } from "@/lib/clerk/personal-org"
import { PersonalOrgProvisioningInProgressError } from "@/lib/clerk/types"
import type { ClerkBackendClient, ClerkOrg, MirrorStore } from "@/lib/clerk/types"

function client(options?: {
  memberships?: ClerkOrg[]
  create?: (input: Parameters<ClerkBackendClient["organizations"]["createOrganization"]>[0]) => Promise<ClerkOrg>
}) {
  let memberships = options?.memberships ?? []
  const createOrganization = vi.fn(async (input: Parameters<ClerkBackendClient["organizations"]["createOrganization"]>[0]) => {
    if (options?.create) return options.create(input)
    const organization = {
      id: "org_personal",
      name: input.name,
      privateMetadata: { personal: true },
    }
    memberships = [organization]
    return organization
  })

  return {
    client: {
      organizations: { createOrganization },
      users: {
        getUser: vi.fn(async (userId: string) => ({ id: userId })),
        getOrganizationMembershipList: vi.fn(async () => ({
          data: memberships.map((organization) => ({ organization })),
        })),
      },
    } as ClerkBackendClient,
    createOrganization,
    setMemberships(value: ClerkOrg[]) {
      memberships = value
    },
  }
}

function lockStore(acquire: (userId: string, ownerToken: string, leaseMs?: number) => Promise<boolean>): Pick<MirrorStore, "acquirePersonalOrgLock" | "releasePersonalOrgLock"> {
  return {
    acquirePersonalOrgLock: acquire,
    releasePersonalOrgLock: vi.fn(async () => undefined),
  }
}

describe("personal organization recovery", () => {
  it("does not create after the lock wait times out", async () => {
    const fake = client()
    const store = lockStore(async () => false)

    await expect(
      reconcilePersonalOrganization({
        userId: "user_timeout",
        clerk: fake.client,
        store,
        lockTimeoutMs: 0,
      })
    ).rejects.toBeInstanceOf(PersonalOrgProvisioningInProgressError)
    expect(fake.createOrganization).not.toHaveBeenCalled()
  })

  it("converges to one organization when the first create outlives its lock", async () => {
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    const remoteOrgs = new Map<string, ClerkOrg>()
    const fake = client()
    let calls = 0
    fake.createOrganization.mockImplementation(async (input) => {
      if (++calls === 1) {
        firstStarted()
        await blocked
      }
      // Model Clerk's instance-wide slug uniqueness, including a slow response.
      if (remoteOrgs.has(input.slug)) throw new Error("slug already exists")
      const org = { id: "org_unique", name: input.name, privateMetadata: { personal: true } }
      remoteOrgs.set(input.slug, org)
      fake.setMemberships([org])
      return org
    })
    const first = reconcilePersonalOrganization({
      userId: "user_expired", clerk: fake.client, store: lockStore(async () => true),
    })
    await started
    // A new coordinator takes the expired lease while the first HTTP call is pending.
    const second = await reconcilePersonalOrganization({
      userId: "user_expired", clerk: fake.client, store: lockStore(async () => true),
    })
    releaseFirst()
    expect(await first).toEqual(second)
    expect(remoteOrgs.size).toBe(1)
    expect(fake.createOrganization).toHaveBeenCalledTimes(2)
  })

  it("reconciles an ambiguous create response through the personal membership", async () => {
    const existing = { id: "org_reconciled", name: "Personal", privateMetadata: { personal: true } }
    const fake = client()
    fake.createOrganization.mockImplementation(async () => {
      fake.setMemberships([existing])
      throw new Error("timeout")
    })

    const result = await reconcilePersonalOrganization({
      userId: "user_ambiguous",
      clerk: fake.client,
      store: lockStore(async () => true),
    })

    expect(result).toEqual(existing)
    expect(fake.createOrganization).toHaveBeenCalledTimes(1)
  })

  it("keeps an existing personal organization created before stable slugs", async () => {
    const existing = { id: "org_legacy", name: "Existing", privateMetadata: { personal: true } }
    const fake = client({ memberships: [existing] })
    expect(await reconcilePersonalOrganization({
      userId: "user_legacy", clerk: fake.client, store: lockStore(async () => true),
    })).toEqual(existing)
    expect(fake.createOrganization).not.toHaveBeenCalled()
  })

  it("does not adopt an unrelated organization after a create conflict", async () => {
    const fake = client({ memberships: [{ id: "org_team", name: "Team" }] })
    fake.createOrganization.mockRejectedValue(new Error("slug conflict"))
    await expect(reconcilePersonalOrganization({
      userId: "user_conflict", clerk: fake.client, store: lockStore(async () => true),
    })).rejects.toThrow("slug conflict")
  })
})
