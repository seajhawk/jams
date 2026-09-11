// @vitest-environment node
import { randomUUID } from "node:crypto"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, describe, expect, it } from "vitest"

import * as schema from "@/db/schema"
import { createDrizzleMirrorStore } from "@/lib/clerk/mirror-store"
import { StaleClaimError } from "@/lib/clerk/types"

// CI supplies a freshly migrated database. Never substitute memory mocks here.
const databaseUrl = process.env.DATABASE_URL
const query = postgres(databaseUrl ?? "postgresql://jams:jams@localhost:5432/jams", {
  max: 4,
  prepare: false,
})
const store = createDrizzleMirrorStore(drizzle(query, { schema }))
const prefix = `webhook_test_${randomUUID()}`
const ids = (suffix: string) => `${prefix}_${suffix}`
const reserve = (suffix: string) => store.reserveWebhookEvent({
  source: "clerk", externalId: ids(suffix), payload: { type: "test" },
})

describe.skipIf(!databaseUrl)("webhook recovery against Postgres", () => {
  afterAll(async () => {
    await query`delete from webhook_events where external_id like ${prefix + "%"}`
    await query`delete from users where id like ${prefix + "%"}`
    await query`delete from user_provisioning_locks where user_id like ${prefix + "%"}`
    await query.end()
  })

  it("permits only one concurrent claimant", async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => reserve("race")))
    expect(claims.filter((claim) => claim.status === "claimed")).toHaveLength(1)
    expect(claims.filter((claim) => claim.status === "in_progress")).toHaveLength(7)
    const [row] = await query`select attempt_count from webhook_events where external_id = ${ids("race")}`
    expect(row.attempt_count).toBe(1)
  })

  it("retries failures but acknowledges completed duplicates without another attempt", async () => {
    const first = await reserve("retry")
    if (first.status !== "claimed") throw new Error("Expected first claim")
    await store.markWebhookEventFailed(ids("retry"), first.claimToken, new Error("temporary"))
    const second = await reserve("retry")
    if (second.status !== "claimed") throw new Error("Expected retry claim")
    expect(second.claimToken).not.toBe(first.claimToken)
    await store.commitEvent(ids("retry"), second.claimToken)
    expect(await reserve("retry")).toEqual({ status: "completed" })
    const [row] = await query`select attempt_count, last_error from webhook_events where external_id = ${ids("retry")}`
    expect(row).toMatchObject({ attempt_count: 2, last_error: null })
  })

  it("rolls back mirror writes and completion together, then retries successfully", async () => {
    const first = await reserve("rollback")
    if (first.status !== "claimed") throw new Error("Expected claim")
    const user = { id: ids("rollback_user"), email: null, displayName: "Fixture" }
    await expect(store.commitEvent(ids("rollback"), first.claimToken, async (tx) => {
      await tx.upsertUser(user)
      throw new Error("injected crash before completion")
    })).rejects.toThrow("injected crash")
    expect(await query`select id from users where id = ${user.id}`).toHaveLength(0)
    const [unfinished] = await query`select status from webhook_events where external_id = ${ids("rollback")}`
    expect(unfinished.status).toBe("processing")
    await store.markWebhookEventFailed(ids("rollback"), first.claimToken, "crash")
    const retry = await reserve("rollback")
    if (retry.status !== "claimed") throw new Error("Expected retry claim")
    await store.commitEvent(ids("rollback"), retry.claimToken, (tx) => tx.upsertUser(user))
    expect(await query`select id from users where id = ${user.id}`).toHaveLength(1)
    expect(await reserve("rollback")).toEqual({ status: "completed" })
  })

  it("fences an expired owner and rolls back its mutations after takeover", async () => {
    const first = await reserve("fenced")
    if (first.status !== "claimed") throw new Error("Expected claim")
    await query`update webhook_events set last_attempt_at = now() - interval '2 minutes' where external_id = ${ids("fenced")}`
    const second = await reserve("fenced")
    if (second.status !== "claimed") throw new Error("Expected takeover")
    await store.commitEvent(ids("fenced"), second.claimToken)
    await expect(store.commitEvent(ids("fenced"), first.claimToken, (tx) => tx.upsertUser({
      id: ids("stale_user"), email: null, displayName: "Must roll back",
    }))).rejects.toBeInstanceOf(StaleClaimError)
    await expect(store.markWebhookEventFailed(ids("fenced"), first.claimToken, "late failure"))
      .rejects.toBeInstanceOf(StaleClaimError)
    expect(await query`select id from users where id = ${ids("stale_user")}`).toHaveLength(0)
    expect(await reserve("fenced")).toEqual({ status: "completed" })
  })

  it("keeps the new provisioning lock when an expired owner releases", async () => {
    const userId = ids("lock")
    expect(await store.acquirePersonalOrgLock!(userId, "old-owner")).toBe(true)
    expect(await store.acquirePersonalOrgLock!(userId, "new-owner")).toBe(false)
    await query`update user_provisioning_locks set expires_at = now() - interval '1 second' where user_id = ${userId}`
    expect(await store.acquirePersonalOrgLock!(userId, "new-owner")).toBe(true)
    await store.releasePersonalOrgLock!(userId, "old-owner")
    expect(await store.acquirePersonalOrgLock!(userId, "third-owner")).toBe(false)
    await store.releasePersonalOrgLock!(userId, "new-owner")
    expect(await store.acquirePersonalOrgLock!(userId, "third-owner")).toBe(true)
  })
})
