import { describe, expect, it } from "vitest"
import { Webhook } from "svix"
import type { WebhookEvent } from "@clerk/nextjs/server"

import {
  applyClerkWebhookEvent,
  verifyClerkWebhook,
} from "@/lib/clerk/webhook"
import type { ClerkBackendClient, ClerkOrg, ClerkUser, MirrorStore } from "@/lib/clerk/types"

const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"

function userCreatedEvent(): WebhookEvent {
  return {
    type: "user.created",
    object: "event",
    event_attributes: {
      http_request: { client_ip: "127.0.0.1", user_agent: "vitest" },
    },
    data: {
      id: "user_123",
      first_name: "Chris",
      last_name: "Test",
      username: null,
      email_addresses: [
        {
          id: "email_123",
          email_address: "chris@example.com",
        },
      ],
      primary_email_address_id: "email_123",
    },
  } as unknown as WebhookEvent
}

function signedHeaders(payload: string, msgId = "msg_test") {
  const timestamp = new Date()
  const signature = new Webhook(secret).sign(msgId, timestamp, payload)

  return new Headers({
    "svix-id": msgId,
    "svix-signature": signature,
    "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
  })
}

class MemoryMirrorStore implements MirrorStore {
  readonly seen = new Set<string>()
  readonly processed = new Set<string>()
  readonly users = new Map<string, ClerkUser>()
  readonly orgs = new Map<string, ClerkOrg>()

  async reserveWebhookEvent(input: {
    source: "clerk"
    externalId: string
    payload: unknown
  }) {
    if (this.seen.has(input.externalId)) {
      return "duplicate" as const
    }
    this.seen.add(input.externalId)
    return "inserted" as const
  }

  async markWebhookEventProcessed(externalId: string) {
    this.processed.add(externalId)
  }

  async upsertOrg(org: ClerkOrg) {
    this.orgs.set(org.id, org)
  }

  async markOrgDeleted(id: string) {
    this.orgs.delete(id)
  }

  async upsertUser(user: ClerkUser) {
    this.users.set(user.id, user)
  }

  async markUserDeleted(id: string) {
    this.users.delete(id)
  }
}

function fakeClerk(): ClerkBackendClient {
  return {
    organizations: {
      async createOrganization() {
        return {
          id: "org_personal",
          name: "Chris Test's workspace",
          privateMetadata: { personal: true },
        }
      },
    },
    users: {
      async getUser() {
        return { id: "user_123", fullName: "Chris Test" }
      },
      async getOrganizationMembershipList() {
        return { data: [] }
      },
    },
  }
}

describe("Clerk webhook handling", () => {
  it("verifies a real Svix signature with a fake local secret", () => {
    const event = userCreatedEvent()
    const payload = JSON.stringify(event)

    expect(verifyClerkWebhook(payload, signedHeaders(payload), secret).type).toBe(
      "user.created"
    )
  })

  it("uses the Svix id as an idempotency key", async () => {
    const store = new MemoryMirrorStore()
    const event = userCreatedEvent()

    await expect(
      applyClerkWebhookEvent(event, "msg_once", store, fakeClerk())
    ).resolves.toBe("processed")
    await expect(
      applyClerkWebhookEvent(event, "msg_once", store, fakeClerk())
    ).resolves.toBe("duplicate")

    expect(store.users.get("user_123")).toMatchObject({
      email: "chris@example.com",
      displayName: "Chris Test",
    })
    expect(store.orgs.get("org_personal")).toMatchObject({
      privateMetadata: { personal: true },
    })
    expect(store.processed.has("msg_once")).toBe(true)
  })
})
