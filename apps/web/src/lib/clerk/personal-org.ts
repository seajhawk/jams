import { clerkClient } from "@clerk/nextjs/server"

import { drizzleMirrorStore } from "./mirror-store"
import type { ClerkBackendClient, ClerkOrg, MirrorStore } from "./types"

export type EnsurePersonalOrgInput = {
  userId: string
  activeOrgId?: string | null
  fallbackName?: string | null
  clerk?: ClerkBackendClient
  store?: Pick<MirrorStore, "upsertOrg">
  onCreated?: () => Promise<void> | void
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

async function realClerkClient(): Promise<ClerkBackendClient> {
  return clerkClient() as Promise<ClerkBackendClient>
}

// In-process single-flight map to eliminate list-then-create races for concurrent sign-in / webhook calls
const inFlightPersonalOrgPromises = new Map<string, Promise<string>>()

async function executeEnsurePersonalOrganization({
  userId,
  fallbackName,
  clerk,
  store = drizzleMirrorStore,
  onCreated,
}: {
  userId: string
  fallbackName?: string | null
  clerk?: ClerkBackendClient
  store?: Pick<MirrorStore, "upsertOrg">
  onCreated?: () => Promise<void> | void
}): Promise<string> {
  const client = clerk ?? (await realClerkClient())

  // Step 1: Query existing memberships
  const memberships = await client.users.getOrganizationMembershipList({
    userId,
    limit: 100,
  })
  const personalMembership = memberships.data.find((membership) =>
    hasPersonalMetadata(membership.organization)
  )

  if (personalMembership) {
    await store.upsertOrg(personalMembership.organization)
    return personalMembership.organization.id
  }

  // Step 2: Attempt creation, reconciling if an external race already created it
  let created: ClerkOrg
  try {
    created = await client.organizations.createOrganization({
      name: personalOrgName(fallbackName, userId),
      createdBy: userId,
      maxAllowedMemberships: 1,
      privateMetadata: { personal: true },
    })
  } catch (error) {
    // Reconcile: If creation failed (e.g. concurrent creation conflict), re-check memberships
    const retryMemberships = await client.users.getOrganizationMembershipList({
      userId,
      limit: 100,
    })
    const reconciled = retryMemberships.data.find((membership) =>
      hasPersonalMetadata(membership.organization)
    )
    if (reconciled) {
      await store.upsertOrg(reconciled.organization)
      return reconciled.organization.id
    }
    throw error
  }

  // Hook for failure-injection immediately after external Clerk org creation
  if (onCreated) {
    await onCreated()
  }

  // Step 3: Mirror the created org to the local store
  await store.upsertOrg(created)

  return created.id
}

export async function ensurePersonalOrganization({
  userId,
  activeOrgId,
  fallbackName,
  clerk,
  store = drizzleMirrorStore,
  onCreated,
}: EnsurePersonalOrgInput): Promise<string> {
  if (activeOrgId) {
    return activeOrgId
  }

  const existingPromise = inFlightPersonalOrgPromises.get(userId)
  if (existingPromise) {
    return existingPromise
  }

  const promise = (async () => {
    try {
      return await executeEnsurePersonalOrganization({
        userId,
        fallbackName,
        clerk,
        store,
        onCreated,
      })
    } finally {
      inFlightPersonalOrgPromises.delete(userId)
    }
  })()

  inFlightPersonalOrgPromises.set(userId, promise)
  return promise
}
