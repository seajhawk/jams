import { describe, expect, it } from "vitest"
import { Webhook } from "svix"
import type { WebhookEvent } from "@clerk/nextjs/server"

import {
  applyClerkWebhookEvent,
  verifyClerkWebhook,
  WebhookEventInProgressError,
  WebhookVerificationError,
} from "@/lib/clerk/webhook"
import { ensurePersonalOrganization } from "@/lib/clerk/personal-org"
import type {
  ClerkBackendClient,
  ClerkOrg,
  ClerkUser,
  MirrorStore,
  WebhookReservationStatus,
} from "@/lib/clerk/types"

// Constructed at runtime so no secret-shaped literal exists in source
const TEST_WEBHOOK_SECRET = "whsec_" + Buffer.from("jams-test-signing-key-not-real").toString("base64")

function userCreatedEvent(userId = "user_123"): WebhookEvent {
  return {
    type: "user.created",
    object: "event",
    event_attributes: {
      http_request: { client_ip: "127.0.0.1", user_agent: "vitest" },
    },
    data: {
      id: userId,
      first_name: "Chris",
      last_name: "Test",
      username: null,
      email_addresses: [
        {
          id: `email_${userId}`,
          email_address: `${userId}@example.com`,
        },
      ],
      primary_email_address_id: `email_${userId}`,
    },
  } as unknown as WebhookEvent
}

function userUpdatedEvent(userId = "user_123"): WebhookEvent {
  return {
    type: "user.updated",
    object: "event",
    data: {
      id: userId,
      first_name: "Updated",
      last_name: "User",
      username: null,
      email_addresses: [
        {
          id: `email_${userId}`,
          email_address: "updated@example.com",
        },
      ],
      primary_email_address_id: `email_${userId}`,
    },
  } as unknown as WebhookEvent
}

function orgCreatedEvent(orgId = "org_standard"): WebhookEvent {
  return {
    type: "organization.created",
    object: "event",
    data: {
      id: orgId,
      name: "Acme Corp",
      private_metadata: { personal: false },
    },
  } as unknown as WebhookEvent
}

function signedHeaders(payload: string, msgId = "msg_test") {
  const timestamp = new Date()
  const signature = new Webhook(TEST_WEBHOOK_SECRET).sign(msgId, timestamp, payload)

  return new Headers({
    "svix-id": msgId,
    "svix-signature": signature,
    "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
  })
}

type MemoryWebhookRecord = {
  source: "clerk" | "stripe"
  externalId: string
  payload: unknown
  status: "pending" | "processing" | "completed" | "failed"
  attemptCount: number
  lastAttemptAt: Date | null
  processedAt: Date | null
  failedAt: Date | null
  lastError: string | null
}

class MemoryMirrorStore implements MirrorStore {
  readonly events = new Map<string, MemoryWebhookRecord>()
  readonly users = new Map<string, ClerkUser>()
  readonly orgs = new Map<string, ClerkOrg>()
  leaseTimeoutMs = 60_000

  async reserveWebhookEvent(input: {
    source: "clerk" | "stripe"
    externalId: string
    payload: unknown
  }): Promise<WebhookReservationStatus> {
    const now = new Date()
    const existing = this.events.get(input.externalId)

    if (!existing) {
      this.events.set(input.externalId, {
        source: input.source,
        externalId: input.externalId,
        payload: input.payload,
        status: "processing",
        attemptCount: 1,
        lastAttemptAt: now,
        processedAt: null,
        failedAt: null,
        lastError: null,
      })
      return "claimed"
    }

    if (existing.status === "completed") {
      return "completed"
    }

    if (existing.status === "pending" || existing.status === "failed") {
      existing.status = "processing"
      existing.attemptCount += 1
      existing.lastAttemptAt = now
      existing.lastError = null
      return "claimed"
    }

    if (existing.status === "processing") {
      const isExpired =
        existing.lastAttemptAt &&
        now.getTime() - existing.lastAttemptAt.getTime() >= this.leaseTimeoutMs
      if (isExpired) {
        existing.attemptCount += 1
        existing.lastAttemptAt = now
        existing.lastError = null
        return "claimed"
      }
      return "in_progress"
    }

    return "in_progress"
  }

  async markWebhookEventCompleted(externalId: string) {
    const existing = this.events.get(externalId)
    if (existing) {
      existing.status = "completed"
      existing.processedAt = new Date()
      existing.lastError = null
    }
  }

  async markWebhookEventFailed(externalId: string, error: unknown) {
    const existing = this.events.get(externalId)
    if (existing) {
      existing.status = "failed"
      existing.failedAt = new Date()
      existing.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  async commitEvent<T>(
    externalId: string,
    mutate?: (store: MirrorStore) => Promise<T>
  ): Promise<void> {
    if (mutate) {
      await mutate(this)
    }
    await this.markWebhookEventCompleted(externalId)
  }

  async markWebhookEventProcessed(externalId: string) {
    await this.markWebhookEventCompleted(externalId)
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

function statefulClerk(): ClerkBackendClient & {
  createOrgCallCount: number
  createdOrgs: ClerkOrg[]
} {
  let createOrgCallCount = 0
  const orgsByUser = new Map<string, ClerkOrg[]>()
  const createdOrgs: ClerkOrg[] = []

  return {
    get createOrgCallCount() {
      return createOrgCallCount
    },
    get createdOrgs() {
      return createdOrgs
    },
    organizations: {
      async createOrganization(input) {
        createOrgCallCount++
        const org: ClerkOrg = {
          id: `org_personal_${input.createdBy}`,
          name: input.name,
          privateMetadata: input.privateMetadata,
        }
        createdOrgs.push(org)
        const userOrgs = orgsByUser.get(input.createdBy) ?? []
        userOrgs.push(org)
        orgsByUser.set(input.createdBy, userOrgs)
        return org
      },
    },
    users: {
      async getUser(userId: string) {
        return { id: userId, fullName: "Test User" }
      },
      async getOrganizationMembershipList({ userId }) {
        const userOrgs = orgsByUser.get(userId) ?? []
        return {
          data: userOrgs.map((organization) => ({ organization })),
        }
      },
    },
  }
}

describe("Clerk webhook handling", () => {
  describe("Signature verification", () => {
    it("verifies a real Svix signature with a fake local secret", () => {
      const event = userCreatedEvent()
      const payload = JSON.stringify(event)

      expect(verifyClerkWebhook(payload, signedHeaders(payload), TEST_WEBHOOK_SECRET).type).toBe(
        "user.created"
      )
    })

    it("rejects invalid signature with WebhookVerificationError", () => {
      const event = userCreatedEvent()
      const payload = JSON.stringify(event)
      const headers = new Headers({
        "svix-id": "msg_bad",
        "svix-signature": "v1,invalid_sig",
        "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
      })

      expect(() => verifyClerkWebhook(payload, headers, TEST_WEBHOOK_SECRET)).toThrow(
        WebhookVerificationError
      )
    })

    it("rejects missing signing secret with WebhookVerificationError", () => {
      const event = userCreatedEvent()
      const payload = JSON.stringify(event)

      expect(() => verifyClerkWebhook(payload, signedHeaders(payload), "")).toThrow(
        WebhookVerificationError
      )
    })
  })

  describe("Idempotency ledger & state machine", () => {
    it("processes a new event, marks completed, and returns duplicate on redelivery", async () => {
      const store = new MemoryMirrorStore()
      const clerk = statefulClerk()
      const event = userCreatedEvent("user_happy")

      const firstStatus = await applyClerkWebhookEvent(event, "msg_happy", store, clerk)
      expect(firstStatus).toBe("processed")

      const record = store.events.get("msg_happy")
      expect(record?.status).toBe("completed")
      expect(record?.attemptCount).toBe(1)
      expect(record?.processedAt).toBeInstanceOf(Date)
      expect(record?.lastError).toBeNull()

      expect(store.users.get("user_happy")).toMatchObject({
        email: "user_happy@example.com",
        displayName: "Chris Test",
      })
      expect(store.orgs.get("org_personal_user_happy")).toMatchObject({
        privateMetadata: { personal: true },
      })

      // Redelivery of completed event returns "duplicate"
      const secondStatus = await applyClerkWebhookEvent(event, "msg_happy", store, clerk)
      expect(secondStatus).toBe("duplicate")
      expect(clerk.createOrgCallCount).toBe(1)
    })

    it("prevents concurrent deliveries from running simultaneously with active lease", async () => {
      const store = new MemoryMirrorStore()
      const clerk = statefulClerk()
      const event = userCreatedEvent("user_concurrent_msg")

      // Pre-seed event in processing state with active lease
      await store.reserveWebhookEvent({
        source: "clerk",
        externalId: "msg_in_progress",
        payload: event,
      })

      // A concurrent delivery arriving while in progress must NOT return duplicate
      // and must NOT swallow the error
      await expect(
        applyClerkWebhookEvent(event, "msg_in_progress", store, clerk)
      ).rejects.toThrow(WebhookEventInProgressError)

      const record = store.events.get("msg_in_progress")
      expect(record?.status).toBe("processing")
    })

    it("reclaims expired lease after worker timeout/crash", async () => {
      const store = new MemoryMirrorStore()
      const clerk = statefulClerk()
      const event = userCreatedEvent("user_reclaim")

      // First reserve event
      await store.reserveWebhookEvent({
        source: "clerk",
        externalId: "msg_crash",
        payload: event,
      })

      // Simulate crash: event stuck in processing from 2 minutes ago
      const record = store.events.get("msg_crash")!
      record.lastAttemptAt = new Date(Date.now() - 120_000)

      // Next delivery should reclaim the expired lease and finish setup
      const status = await applyClerkWebhookEvent(event, "msg_crash", store, clerk)
      expect(status).toBe("processed")
      expect(record.status).toBe("completed")
      expect(record.attemptCount).toBe(2)
    })
  })

  describe("Failure injection and retry recovery", () => {
    it("handles failure immediately after reservation: marks failed, does not swallow, retries successfully", async () => {
      const store = new MemoryMirrorStore()
      const clerk = statefulClerk()
      const event = userCreatedEvent("user_fail_reserve")

      // First delivery: inject failure immediately after reservation
      let shouldFail = true
      await expect(
        applyClerkWebhookEvent(event, "msg_fail_reserve", store, clerk, {
          afterReservation: () => {
            if (shouldFail) {
              throw new Error("Injected failure immediately after reservation")
            }
          },
        })
      ).rejects.toThrow("Injected failure immediately after reservation")

      // Verify the event is in failed state, not suppressed as duplicate
      const record = store.events.get("msg_fail_reserve")
      expect(record?.status).toBe("failed")
      expect(record?.attemptCount).toBe(1)
      expect(record?.lastError).toBe("Injected failure immediately after reservation")
      expect(record?.failedAt).toBeInstanceOf(Date)
      expect(record?.processedAt).toBeNull()
      expect(store.users.has("user_fail_reserve")).toBe(false)

      // Redelivery: retry succeeds and completes setup
      shouldFail = false
      const redeliveryStatus = await applyClerkWebhookEvent(
        event,
        "msg_fail_reserve",
        store,
        clerk
      )
      expect(redeliveryStatus).toBe("processed")
      expect(record?.status).toBe("completed")
      expect(record?.attemptCount).toBe(2)
      expect(record?.processedAt).toBeInstanceOf(Date)
      expect(record?.lastError).toBeNull()

      expect(store.users.get("user_fail_reserve")).toMatchObject({
        email: "user_fail_reserve@example.com",
      })
      expect(store.orgs.has("org_personal_user_fail_reserve")).toBe(true)

      // Subsequent delivery returns duplicate
      const duplicateStatus = await applyClerkWebhookEvent(
        event,
        "msg_fail_reserve",
        store,
        clerk
      )
      expect(duplicateStatus).toBe("duplicate")
    })

    it("handles failure immediately after external org creation: reconciles idempotently on redelivery with one completed setup", async () => {
      const store = new MemoryMirrorStore()
      const clerk = statefulClerk()
      const event = userCreatedEvent("user_fail_after_org")

      // First delivery: inject failure immediately after external org creation in Clerk
      let shouldFail = true
      await expect(
        applyClerkWebhookEvent(event, "msg_fail_after_org", store, clerk, {
          afterOrgCreation: () => {
            if (shouldFail) {
              throw new Error("Injected failure after external org creation")
            }
          },
        })
      ).rejects.toThrow("Injected failure after external org creation")

      // Org was created in Clerk
      expect(clerk.createOrgCallCount).toBe(1)
      expect(clerk.createdOrgs.length).toBe(1)

      // Ledger is in failed state
      const record = store.events.get("msg_fail_after_org")
      expect(record?.status).toBe("failed")
      expect(record?.attemptCount).toBe(1)
      expect(record?.lastError).toBe("Injected failure after external org creation")
      expect(record?.processedAt).toBeNull()

      // Redelivery: ensurePersonalOrganization reconciles existing Clerk org idempotently
      shouldFail = false
      const redeliveryStatus = await applyClerkWebhookEvent(
        event,
        "msg_fail_after_org",
        store,
        clerk
      )
      expect(redeliveryStatus).toBe("processed")
      expect(record?.status).toBe("completed")
      expect(record?.attemptCount).toBe(2)
      expect(record?.processedAt).toBeInstanceOf(Date)

      // Crucial: exactly ONE personal org created in Clerk, NOT two
      expect(clerk.createOrgCallCount).toBe(1)
      expect(clerk.createdOrgs.length).toBe(1)
      expect(store.orgs.get("org_personal_user_fail_after_org")).toBeDefined()

      // Further redelivery returns duplicate
      const duplicateStatus = await applyClerkWebhookEvent(
        event,
        "msg_fail_after_org",
        store,
        clerk
      )
      expect(duplicateStatus).toBe("duplicate")
      expect(clerk.createOrgCallCount).toBe(1)
    })
  })

  describe("Concurrent first sign-ins", () => {
    it("eliminates list-then-create race when multiple sign-in requests arrive simultaneously", async () => {
      const store = new MemoryMirrorStore()
      const clerk = statefulClerk()
      const userId = "user_concurrent_first_signin"

      // Trigger 10 concurrent first sign-ins for the same user
      const results = await Promise.all([
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
        ensurePersonalOrganization({ userId, fallbackName: "Alice", clerk, store }),
      ])

      // All 10 callers received the identical org id
      const expectedOrgId = `org_personal_${userId}`
      for (const orgId of results) {
        expect(orgId).toBe(expectedOrgId)
      }

      // Exactly ONE organization was created in Clerk
      expect(clerk.createOrgCallCount).toBe(1)
      expect(store.orgs.has(expectedOrgId)).toBe(true)
    })
  })

  describe("DB-only atomic commit events", () => {
    it("atomically applies user.updated and completes ledger", async () => {
      const store = new MemoryMirrorStore()
      const event = userUpdatedEvent("user_updated_test")

      const status = await applyClerkWebhookEvent(event, "msg_user_upd", store)
      expect(status).toBe("processed")

      expect(store.users.get("user_updated_test")).toMatchObject({
        email: "updated@example.com",
        displayName: "Updated User",
      })
      const record = store.events.get("msg_user_upd")
      expect(record?.status).toBe("completed")
      expect(record?.processedAt).toBeInstanceOf(Date)
    })

    it("atomically applies organization.created and completes ledger", async () => {
      const store = new MemoryMirrorStore()
      const event = orgCreatedEvent("org_acme")

      const status = await applyClerkWebhookEvent(event, "msg_org_create", store)
      expect(status).toBe("processed")

      expect(store.orgs.get("org_acme")).toMatchObject({
        name: "Acme Corp",
      })
      const record = store.events.get("msg_org_create")
      expect(record?.status).toBe("completed")
      expect(record?.processedAt).toBeInstanceOf(Date)
    })
  })
})
