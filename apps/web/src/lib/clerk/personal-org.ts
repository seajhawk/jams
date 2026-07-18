import { clerkClient } from "@clerk/nextjs/server"

import { drizzleMirrorStore } from "./mirror-store"
import type { ClerkBackendClient, ClerkOrg, MirrorStore } from "./types"

type EnsurePersonalOrgInput = {
  userId: string
  activeOrgId?: string | null
  fallbackName?: string | null
  clerk?: ClerkBackendClient
  store?: Pick<MirrorStore, "upsertOrg">
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

export async function ensurePersonalOrganization({
  userId,
  activeOrgId,
  fallbackName,
  clerk,
  store = drizzleMirrorStore,
}: EnsurePersonalOrgInput): Promise<string> {
  if (activeOrgId) {
    return activeOrgId
  }

  const client = clerk ?? (await realClerkClient())
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

  const created = await client.organizations.createOrganization({
    name: personalOrgName(fallbackName, userId),
    createdBy: userId,
    maxAllowedMemberships: 1,
    privateMetadata: { personal: true },
  })
  await store.upsertOrg(created)

  return created.id
}
