import type {
  DeletedObjectJSON,
  OrganizationJSON,
  UserJSON,
  WebhookEvent,
} from "@clerk/nextjs/server"
import { Webhook } from "svix"

import { ensurePersonalOrganization } from "./personal-org"
import type { ClerkBackendClient, ClerkUser, MirrorStore } from "./types"

export class WebhookVerificationError extends Error {}

export class WebhookEventInProgressError extends Error {
  constructor(
    public readonly externalId: string,
    message = `Webhook event ${externalId} is currently being processed`
  ) {
    super(message)
    this.name = "WebhookEventInProgressError"
  }
}

export type WebhookTestHooks = {
  afterReservation?: () => Promise<void> | void
  afterOrgCreation?: () => Promise<void> | void
}

function primaryEmail(user: UserJSON): string | null {
  const email = user.email_addresses.find(
    (entry) => entry.id === user.primary_email_address_id
  )
  return email?.email_address ?? user.email_addresses[0]?.email_address ?? null
}

function displayName(user: UserJSON): string | null {
  const parts = [user.first_name, user.last_name].filter(Boolean)
  if (parts.length > 0) {
    return parts.join(" ")
  }
  return user.username ?? primaryEmail(user)
}

function mapUser(user: UserJSON): ClerkUser {
  return {
    id: user.id,
    email: primaryEmail(user),
    displayName: displayName(user),
  }
}

function mapOrg(org: OrganizationJSON) {
  return {
    id: org.id,
    name: org.name,
    privateMetadata: org.private_metadata,
  }
}

function deletedId(data: DeletedObjectJSON): string {
  if (!data.id) {
    throw new Error("Deleted Clerk object is missing id")
  }
  return data.id
}

export function clerkWebhookId(headers: Headers): string | null {
  return headers.get("svix-id")
}

export function verifyClerkWebhook(
  payload: string,
  headers: Headers,
  secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? process.env.CLERK_WEBHOOK_SECRET
): WebhookEvent {
  if (!secret) {
    throw new WebhookVerificationError("Missing Clerk webhook signing secret")
  }

  const svixHeaders = {
    "svix-id": headers.get("svix-id") ?? "",
    "svix-timestamp": headers.get("svix-timestamp") ?? "",
    "svix-signature": headers.get("svix-signature") ?? "",
  }

  try {
    return new Webhook(secret).verify(payload, svixHeaders) as WebhookEvent
  } catch (error) {
    throw new WebhookVerificationError(
      error instanceof Error ? error.message : "Invalid Clerk webhook signature"
    )
  }
}

export async function applyClerkWebhookEvent(
  event: WebhookEvent,
  externalId: string,
  store: MirrorStore,
  clerk?: ClerkBackendClient,
  hooks?: WebhookTestHooks
): Promise<"processed" | "duplicate" | "ignored"> {
  const reserved = await store.reserveWebhookEvent({
    source: "clerk",
    externalId,
    payload: event,
  })

  // Do not suppress unfinished work: only completed events are considered duplicates
  if (reserved === "completed" || reserved === ("duplicate" as unknown)) {
    return "duplicate"
  }

  // Active lease: another attempt is currently processing this event
  if (reserved === "in_progress") {
    throw new WebhookEventInProgressError(externalId)
  }

  try {
    if (hooks?.afterReservation) {
      await hooks.afterReservation()
    }

    switch (event.type) {
      case "user.created": {
        const user = mapUser(event.data)
        await store.upsertUser(user)
        await ensurePersonalOrganization({
          userId: user.id,
          fallbackName: user.displayName,
          clerk,
          store,
          onCreated: hooks?.afterOrgCreation,
        })
        if (store.commitEvent) {
          await store.commitEvent(externalId)
        } else {
          await store.markWebhookEventCompleted(externalId)
        }
        break
      }
      case "user.updated": {
        const user = mapUser(event.data)
        if (store.commitEvent) {
          await store.commitEvent(externalId, (s) => s.upsertUser(user))
        } else {
          await store.upsertUser(user)
          await store.markWebhookEventCompleted(externalId)
        }
        break
      }
      case "user.deleted": {
        const id = deletedId(event.data)
        if (store.commitEvent) {
          await store.commitEvent(externalId, (s) => s.markUserDeleted(id))
        } else {
          await store.markUserDeleted(id)
          await store.markWebhookEventCompleted(externalId)
        }
        break
      }
      case "organization.created":
      case "organization.updated": {
        const org = mapOrg(event.data)
        if (store.commitEvent) {
          await store.commitEvent(externalId, (s) => s.upsertOrg(org))
        } else {
          await store.upsertOrg(org)
          await store.markWebhookEventCompleted(externalId)
        }
        break
      }
      case "organization.deleted": {
        const id = deletedId(event.data)
        if (store.commitEvent) {
          await store.commitEvent(externalId, (s) => s.markOrgDeleted(id))
        } else {
          await store.markOrgDeleted(id)
          await store.markWebhookEventCompleted(externalId)
        }
        break
      }
      case "organizationMembership.created": {
        const org = mapOrg(event.data.organization)
        if (store.commitEvent) {
          await store.commitEvent(externalId, (s) => s.upsertOrg(org))
        } else {
          await store.upsertOrg(org)
          await store.markWebhookEventCompleted(externalId)
        }
        break
      }
      case "organizationMembership.deleted": {
        if (store.commitEvent) {
          await store.commitEvent(externalId)
        } else {
          await store.markWebhookEventCompleted(externalId)
        }
        break
      }
      default: {
        if (store.commitEvent) {
          await store.commitEvent(externalId)
        } else {
          await store.markWebhookEventCompleted(externalId)
        }
        return "ignored"
      }
    }
  } catch (error) {
    // Record explicit failed state so retries can claim the event and unfinished work is not suppressed
    await store.markWebhookEventFailed(externalId, error)
    throw error
  }

  return "processed"
}
