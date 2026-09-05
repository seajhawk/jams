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

export type WebhookReservationStatus = "claimed" | "completed" | "in_progress"

export type MirrorStore = {
  reserveWebhookEvent(input: {
    source: "clerk" | "stripe"
    externalId: string
    payload: unknown
  }): Promise<WebhookReservationStatus | "inserted" | "duplicate">
  markWebhookEventCompleted(externalId: string): Promise<void>
  markWebhookEventFailed(externalId: string, error: unknown): Promise<void>
  commitEvent?<T>(
    externalId: string,
    mutate?: (store: MirrorStore) => Promise<T>
  ): Promise<void>
  markWebhookEventProcessed(externalId: string): Promise<void>
  upsertOrg(org: ClerkOrg): Promise<void>
  markOrgDeleted(id: string): Promise<void>
  upsertUser(user: ClerkUser): Promise<void>
  markUserDeleted(id: string): Promise<void>
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
