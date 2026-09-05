import { eq, sql } from "drizzle-orm"

import { adminDb } from "@/db/admin-client.server"
import { orgs, users, webhookEvents, weightProfiles } from "@/db/schema"
import {
  DEFAULT_WEIGHT_PROFILE_NAME,
  DEFAULT_WEIGHT_PROFILE_NORMALIZATION,
  DEFAULT_WEIGHT_PROFILE_WEIGHTS,
} from "@/lib/weight-profiles"
import type { MirrorStore } from "./types"

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

      // Bypass RLS: webhook idempotency is global and has no tenant org_id.
      const claimed = await dbClient
        .insert(webhookEvents)
        .values({
          source: input.source,
          externalId: input.externalId,
          payload: input.payload,
          status: "processing",
          attemptCount: 1,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: webhookEvents.externalId,
          set: {
            status: "processing",
            attemptCount: sql`${webhookEvents.attemptCount} + 1`,
            lastAttemptAt: now,
            updatedAt: now,
            lastError: null,
          },
          setWhere: sql`${webhookEvents.status} IN ('pending', 'failed') OR (${webhookEvents.status} = 'processing' AND ${webhookEvents.lastAttemptAt} < ${leaseCutoff})`,
        })
        .returning({
          externalId: webhookEvents.externalId,
          status: webhookEvents.status,
        })

      if (claimed.length > 0) {
        return "claimed"
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
        return "completed"
      }

      return "in_progress"
    },

    async markWebhookEventCompleted(externalId) {
      // Bypass RLS: webhook idempotency is global and has no tenant org_id.
      const now = new Date()
      await dbClient
        .update(webhookEvents)
        .set({
          status: "completed",
          processedAt: now,
          updatedAt: now,
          lastError: null,
        })
        .where(eq(webhookEvents.externalId, externalId))
    },

    async markWebhookEventFailed(externalId, error) {
      // Bypass RLS: webhook idempotency is global and has no tenant org_id.
      const now = new Date()
      await dbClient
        .update(webhookEvents)
        .set({
          status: "failed",
          failedAt: now,
          updatedAt: now,
          lastError: error instanceof Error ? error.message : String(error),
        })
        .where(eq(webhookEvents.externalId, externalId))
    },

    async commitEvent<T>(
      externalId: string,
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
          await txStore.markWebhookEventCompleted(externalId)
        })
      } else {
        if (mutate) {
          await mutate(store)
        }
        await store.markWebhookEventCompleted(externalId)
      }
    },

    async markWebhookEventProcessed(externalId) {
      await store.markWebhookEventCompleted(externalId)
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
