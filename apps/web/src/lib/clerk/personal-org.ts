import { clerkClient } from "@clerk/nextjs/server"
import { createHash } from "node:crypto"

import { drizzleMirrorStore } from "./mirror-store"
import {
  PersonalOrgProvisioningInProgressError,
  type ClerkBackendClient,
  type ClerkOrg,
  type MirrorStore,
} from "./types"

export type ReconcilePersonalOrgInput = {
  userId: string
  fallbackName?: string | null
  clerk?: ClerkBackendClient
  store?: Pick<MirrorStore, "acquirePersonalOrgLock" | "releasePersonalOrgLock">
  onCreated?: () => Promise<void> | void
  lockLeaseMs?: number
  lockTimeoutMs?: number
}

export type EnsurePersonalOrgInput = {
  userId: string
  activeOrgId?: string | null
  fallbackName?: string | null
  clerk?: ClerkBackendClient
  store?: Pick<MirrorStore, "upsertOrg" | "acquirePersonalOrgLock" | "releasePersonalOrgLock">
  onCreated?: () => Promise<void> | void
  lockLeaseMs?: number
  lockTimeoutMs?: number
}

function hasPersonalMetadata(org: ClerkOrg): boolean {
  const metadata = org.privateMetadata
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "personal" in metadata &&
    metadata.personal === true
  )
}

function personalOrgName(fallbackName: string | null | undefined, userId: string) {
  const trimmed = fallbackName?.trim()
  return trimmed ? `${trimmed}'s workspace` : `Personal workspace ${userId.slice(-6)}`
}

function personalOrgSlug(userId: string): string {
  const digest = createHash("sha256").update(userId).digest("hex")
  return `jams-personal-${digest.slice(0, 32)}`
}

async function realClerkClient(): Promise<ClerkBackendClient> {
  return clerkClient() as Promise<ClerkBackendClient>
}

/**
 * Reconciles or creates a Clerk personal organization with durable per-user locking
 * to serialize normal requests. A stable Clerk slug also protects creation
 * when an external request outlives its lock lease.
 */
export async function reconcilePersonalOrganization({
  userId,
  fallbackName,
  clerk,
  store,
  onCreated,
  lockLeaseMs = 15_000,
  lockTimeoutMs = 5_000,
}: ReconcilePersonalOrgInput): Promise<ClerkOrg> {
  const client = clerk ?? (await realClerkClient())
  const lockToken = crypto.randomUUID()
  const startTime = Date.now()

  let hasLock = false
  if (store?.acquirePersonalOrgLock) {
    while (!hasLock) {
      hasLock = await store.acquirePersonalOrgLock(userId, lockToken, lockLeaseMs)
      if (hasLock) {
        break
      }

      // While waiting for the lock, check if another process already completed provisioning
      const memberships = await client.users.getOrganizationMembershipList({
        userId,
        limit: 100,
      })
      const existing = memberships.data.find((m) => hasPersonalMetadata(m.organization))
      if (existing) {
        return existing.organization
      }

      if (Date.now() - startTime >= lockTimeoutMs) {
        throw new PersonalOrgProvisioningInProgressError(userId)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  try {
    // Check again after acquiring the lock; another request may have finished.
    const memberships = await client.users.getOrganizationMembershipList({
      userId,
      limit: 100,
    })
    const personalMembership = memberships.data.find((m) =>
      hasPersonalMetadata(m.organization)
    )

    if (personalMembership) {
      return personalMembership.organization
    }

    // Attempt creation, reconciling if another process created it concurrently
    let created: ClerkOrg
    try {
      created = await client.organizations.createOrganization({
        name: personalOrgName(fallbackName, userId),
        slug: personalOrgSlug(userId),
        createdBy: userId,
        maxAllowedMemberships: 1,
        privateMetadata: { personal: true },
      })
    } catch (error) {
      const retryMemberships = await client.users.getOrganizationMembershipList({
        userId,
        limit: 100,
      })
      const reconciled = retryMemberships.data.find((m) =>
        hasPersonalMetadata(m.organization)
      )
      if (reconciled) {
        return reconciled.organization
      }
      throw error
    }

    if (onCreated) {
      await onCreated()
    }

    return created
  } finally {
    if (hasLock && store?.releasePersonalOrgLock) {
      await store.releasePersonalOrgLock(userId, lockToken)
    }
  }
}

export async function ensurePersonalOrganization({
  userId,
  activeOrgId,
  fallbackName,
  clerk,
  store = drizzleMirrorStore,
  onCreated,
  lockLeaseMs,
  lockTimeoutMs,
}: EnsurePersonalOrgInput): Promise<string> {
  if (activeOrgId) {
    return activeOrgId
  }

  const personalOrg = await reconcilePersonalOrganization({
    userId,
    fallbackName,
    clerk,
    store,
    onCreated,
    lockLeaseMs,
    lockTimeoutMs,
  })

  if (store?.upsertOrg) {
    await store.upsertOrg(personalOrg)
  }

  return personalOrg.id
}
