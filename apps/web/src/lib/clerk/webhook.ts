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
  clerk?: ClerkBackendClient
): Promise<"processed" | "duplicate" | "ignored"> {
  const reserved = await store.reserveWebhookEvent({
    source: "clerk",
    externalId,
    payload: event,
  })

  if (reserved === "duplicate") {
    return "duplicate"
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
      })
      break
    }
    case "user.updated":
      await store.upsertUser(mapUser(event.data))
      break
    case "user.deleted":
      await store.markUserDeleted(deletedId(event.data))
      break
    case "organization.created":
    case "organization.updated":
      await store.upsertOrg(mapOrg(event.data))
      break
    case "organization.deleted":
      await store.markOrgDeleted(deletedId(event.data))
      break
    case "organizationMembership.created":
      await store.upsertOrg(mapOrg(event.data.organization))
      break
    case "organizationMembership.deleted":
      break
    default:
      await store.markWebhookEventProcessed(externalId)
      return "ignored"
  }

  await store.markWebhookEventProcessed(externalId)
  return "processed"
}
