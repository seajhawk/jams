import { eq } from "drizzle-orm"

import { db } from "@/db/client"
import { orgs, users, webhookEvents } from "@/db/schema"
import type { MirrorStore } from "./types"

function isPersonalOrg(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "personal" in metadata &&
    metadata.personal === true
  )
}

export const drizzleMirrorStore: MirrorStore = {
  async reserveWebhookEvent(input) {
    const inserted = await db
      .insert(webhookEvents)
      .values({
        source: input.source,
        externalId: input.externalId,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: webhookEvents.externalId })
      .returning({ externalId: webhookEvents.externalId })

    return inserted.length === 0 ? "duplicate" : "inserted"
  },

  async markWebhookEventProcessed(externalId) {
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.externalId, externalId))
  },

  async upsertOrg(org) {
    await db
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
  },

  async markOrgDeleted(id) {
    await db
      .update(orgs)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(orgs.id, id))
  },

  async upsertUser(user) {
    await db
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
    await db
      .update(users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id))
  },
}
