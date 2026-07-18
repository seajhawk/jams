import { eq } from "drizzle-orm"

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

export const drizzleMirrorStore: MirrorStore = {
  async reserveWebhookEvent(input) {
    // Bypass RLS: webhook idempotency is global and has no tenant org_id.
    const inserted = await adminDb
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
    // Bypass RLS: webhook idempotency is global and has no tenant org_id.
    await adminDb
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.externalId, externalId))
  },

  async upsertOrg(org) {
    // Bypass RLS: Clerk can create/update org mirror rows before the web app
    // has an app.org_id scope for that org.
    await adminDb
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
    await adminDb
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
    await adminDb
      .update(orgs)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(orgs.id, id))
  },

  async upsertUser(user) {
    // Bypass RLS: users are a global Clerk mirror table, not tenant-owned rows.
    await adminDb
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
    await adminDb
      .update(users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id))
  },
}
