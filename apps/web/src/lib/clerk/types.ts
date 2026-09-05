export type ClerkOrg = {
  id: string
  name: string
  privateMetadata?: unknown
}

export type ClerkUser = {
  id: string
  email: string | null
  displayName: string | null
}

export type WebhookReservation =
  | { status: "claimed"; claimToken: string }
  | { status: "completed" }
  | { status: "in_progress" }

export class StaleClaimError extends Error {
  constructor(
    public readonly externalId: string,
    public readonly claimToken: string,
    message = `Stale claim finalized for webhook event ${externalId} (claimToken: ${claimToken})`
  ) {
    super(message)
    this.name = "StaleClaimError"
  }
}

export type MirrorStore = {
  reserveWebhookEvent(input: {
    source: "clerk" | "stripe"
    externalId: string
    payload: unknown
  }): Promise<WebhookReservation>
  markWebhookEventCompleted(externalId: string, claimToken: string): Promise<void>
  markWebhookEventFailed(externalId: string, claimToken: string, error: unknown): Promise<void>
  commitEvent<T>(
    externalId: string,
    claimToken: string,
    mutate?: (store: MirrorStore) => Promise<T>
  ): Promise<void>
  markWebhookEventProcessed(externalId: string, claimToken?: string): Promise<void>
  upsertOrg(org: ClerkOrg): Promise<void>
  markOrgDeleted(id: string): Promise<void>
  upsertUser(user: ClerkUser): Promise<void>
  markUserDeleted(id: string): Promise<void>
  acquirePersonalOrgLock?(userId: string, ownerToken: string, leaseMs?: number): Promise<boolean>
  releasePersonalOrgLock?(userId: string, ownerToken: string): Promise<void>
}

export type OrganizationMembership = {
  organization: ClerkOrg
}

export type ClerkBackendClient = {
  organizations: {
    createOrganization(input: {
      name: string
      createdBy: string
      maxAllowedMemberships: number
      privateMetadata: { personal: true }
    }): Promise<ClerkOrg>
  }
  users: {
    getUser(userId: string): Promise<{
      id: string
      firstName?: string | null
      lastName?: string | null
      fullName?: string | null
      username?: string | null
      emailAddresses?: Array<{ id: string; emailAddress: string }>
      primaryEmailAddressId?: string | null
    }>
    getOrganizationMembershipList(input: {
      userId: string
      limit?: number
    }): Promise<{ data: OrganizationMembership[] }>
  }
}
