import { and, eq, inArray, lt, or, sql } from "drizzle-orm"

import { adminDb } from "@/db/admin-client.server"
import { orgs, userProvisioningLocks, users, webhookEvents, weightProfiles } from "@/db/schema"
import {
  DEFAULT_WEIGHT_PROFILE_NAME,
  DEFAULT_WEIGHT_PROFILE_NORMALIZATION,
  DEFAULT_WEIGHT_PROFILE_WEIGHTS,
} from "@/lib/weight-profiles"
import { type MirrorStore, StaleClaimError } from "./types"

function isPersonalOrg(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "personal" in metadata &&
    metadata.personal === true
  )
}

const DEFAULT_LEASE_TIMEOUT_MS = 60_000

export function createDrizzleMirrorStore(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbClient: any = adminDb
): MirrorStore {
  const store: MirrorStore = {
    async reserveWebhookEvent(input) {
      const now = new Date()
      const leaseCutoff = new Date(now.getTime() - DEFAULT_LEASE_TIMEOUT_MS)
      const claimToken = crypto.randomUUID()

      // Bypass RLS: webhook idempotency is global and has no tenant org_id.
      const claimed = await dbClient
        .insert(webhookEvents)
        .values({
          source: input.source,
          externalId: input.externalId,
          payload: input.payload,
          status: "processing",
          claimToken,
          attemptCount: 1,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: webhookEvents.externalId,
          set: {
            status: "processing",
            claimToken,
            attemptCount: sql`${webhookEvents.attemptCount} + 1`,
            lastAttemptAt: now,
            updatedAt: now,
            lastError: null,
          },
          setWhere: or(
            inArray(webhookEvents.status, ["pending", "failed"]),
            and(
              eq(webhookEvents.status, "processing"),
              lt(webhookEvents.lastAttemptAt, leaseCutoff)
            )
          ),
        })
        .returning({
          externalId: webhookEvents.externalId,
          status: webhookEvents.status,
          claimToken: webhookEvents.claimToken,
        })

      if (claimed.length > 0) {
        return {
          status: "claimed",
          claimToken: claimed[0].claimToken ?? claimToken,
        }
      }

      // Row was not inserted or updated. Query the existing event's status.
      const existing = await dbClient
        .select({
          status: webhookEvents.status,
        })
        .from(webhookEvents)
        .where(eq(webhookEvents.externalId, input.externalId))
        .limit(1)

      if (existing[0]?.status === "completed") {
        return { status: "completed" }
      }

      return { status: "in_progress" }
    },

    async markWebhookEventCompleted(externalId, claimToken) {
      // Bypass RLS: webhook idempotency is global and has no tenant org_id.
      const now = new Date()
      const updated = await dbClient
        .update(webhookEvents)
        .set({
          status: "completed",
          processedAt: now,
          updatedAt: now,
          lastError: null,
        })
        .where(
          and(
            eq(webhookEvents.externalId, externalId),
            eq(webhookEvents.status, "processing"),
            eq(webhookEvents.claimToken, claimToken)
          )
        )
        .returning({ externalId: webhookEvents.externalId })

      if (updated.length === 0) {
        throw new StaleClaimError(externalId, claimToken)
      }
    },

    async markWebhookEventFailed(externalId, claimToken, error) {
      // Bypass RLS: webhook idempotency is global and has no tenant org_id.
      const now = new Date()
      const updated = await dbClient
        .update(webhookEvents)
        .set({
          status: "failed",
          failedAt: now,
          updatedAt: now,
          lastError: error instanceof Error ? error.message : String(error),
        })
        .where(
          and(
            eq(webhookEvents.externalId, externalId),
            eq(webhookEvents.status, "processing"),
            eq(webhookEvents.claimToken, claimToken)
          )
        )
        .returning({ externalId: webhookEvents.externalId })

      if (updated.length === 0) {
        throw new StaleClaimError(externalId, claimToken)
      }
    },

    async commitEvent<T>(
      externalId: string,
      claimToken: string,
      mutate?: (store: MirrorStore) => Promise<T>
    ): Promise<void> {
      // Bypass RLS: webhook idempotency and mirror operations are trusted admin work.
      if ("transaction" in dbClient && typeof dbClient.transaction === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await dbClient.transaction(async (tx: any) => {
          const txStore = createDrizzleMirrorStore(tx)
          if (mutate) {
            await mutate(txStore)
          }
          await txStore.markWebhookEventCompleted(externalId, claimToken)
        })
      } else {
        if (mutate) {
          await mutate(store)
        }
        await store.markWebhookEventCompleted(externalId, claimToken)
      }
    },

    async markWebhookEventProcessed(externalId, claimToken) {
      await store.markWebhookEventCompleted(externalId, claimToken ?? "")
    },

    async acquirePersonalOrgLock(userId, ownerToken, leaseMs = 15_000) {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + leaseMs)

      const acquired = await dbClient
        .insert(userProvisioningLocks)
        .values({
          userId,
          lockedBy: ownerToken,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userProvisioningLocks.userId,
          set: {
            lockedBy: ownerToken,
            expiresAt,
            updatedAt: now,
          },
          setWhere: lt(userProvisioningLocks.expiresAt, now),
        })
        .returning({ userId: userProvisioningLocks.userId })

      return acquired.length > 0
    },

    async releasePersonalOrgLock(userId, ownerToken) {
      await dbClient
        .delete(userProvisioningLocks)
        .where(
          and(
            eq(userProvisioningLocks.userId, userId),
            eq(userProvisioningLocks.lockedBy, ownerToken)
          )
        )
    },

    async upsertOrg(org) {
      // Bypass RLS: Clerk can create/update org mirror rows before the web app
      // has an app.org_id scope for that org.
      await dbClient
        .insert(orgs)
        .values({
          id: org.id,
          name: org.name,
          isPersonal: isPersonalOrg(org.privateMetadata),
          deletedAt: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: orgs.id,
          set: {
            name: org.name,
            isPersonal: isPersonalOrg(org.privateMetadata),
            deletedAt: null,
            updatedAt: new Date(),
          },
        })

      // Bypass RLS: seeding the org default profile is part of trusted org mirroring.
      await dbClient
        .insert(weightProfiles)
        .values({
          orgId: org.id,
          name: DEFAULT_WEIGHT_PROFILE_NAME,
          weights: DEFAULT_WEIGHT_PROFILE_WEIGHTS,
          normalization: DEFAULT_WEIGHT_PROFILE_NORMALIZATION,
          isDefault: true,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
    },

    async markOrgDeleted(id) {
      // Bypass RLS: Clerk deletion events are trusted mirror maintenance.
      await dbClient
        .update(orgs)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(orgs.id, id))
    },

    async upsertUser(user) {
      // Bypass RLS: users are a global Clerk mirror table, not tenant-owned rows.
      await dbClient
        .insert(users)
        .values({
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email: user.email,
            displayName: user.displayName,
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
    },

    async markUserDeleted(id) {
      // Bypass RLS: users are a global Clerk mirror table, not tenant-owned rows.
      await dbClient
        .update(users)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, id))
    },
  }

  return store
}

export const drizzleMirrorStore: MirrorStore = createDrizzleMirrorStore(adminDb)
