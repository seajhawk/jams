// @vitest-environment node
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import * as schema from "@/db/schema"
import { resolveLimitPolicy, type LimitPolicy } from "@/lib/limits"
import { assertAnalysisAdmission, assertUploadAdmission } from "@/lib/preview-limits"
import {
  consumeRateLimit,
  purgeExpiredRateLimitCounters,
  resetRateLimitCacheForTests,
} from "@/lib/rate-limit"
import { bindOrgToTransaction, type OrgContext } from "@/lib/with-org"

/**
 * The general (non-preview) quotas, the global circuit breakers and the rate limiter, against
 * real Postgres with the web role, so RLS, advisory locks and the security-definer functions are
 * exercised as deployed. preview-limits.integration.test.ts keeps covering preview mode.
 */

const admin = postgres(process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams", { max: 2 })
const web = postgres(process.env.DATABASE_URL_WEB ?? "postgresql://jams_web:jams_web@localhost:5432/jams", { max: 8 })
const database = drizzle(web, { schema })
const organizations: string[] = []

function policy(env: Record<string, string>): LimitPolicy {
  return resolveLimitPolicy({ env })
}

async function newOrg() {
  const id = `limits_${randomUUID()}`
  await admin`insert into orgs (id,name) values (${id},'Limits test')`
  organizations.push(id)
  return id
}
async function scoped<T>(org: string, fn: (db: OrgContext["scopedDb"]) => Promise<T>) {
  return database.transaction(async (tx) => fn(await bindOrgToTransaction(tx, org)))
}
async function upload(org: string, bytes: number, limits: LimitPolicy) {
  return scoped(org, async (db) => {
    await assertUploadAdmission(db, bytes, { policy: limits })
    const [video] = await db.db.insert(schema.videos).values({
      orgId: org, title: "Limits upload", blobPath: `test/${randomUUID()}`,
      uploadedBy: "test", sizeBytes: bytes, status: "uploading",
    }).returning()
    return video
  })
}
async function videoFor(org: string) {
  const id = randomUUID()
  await admin`insert into videos (id,org_id,title,blob_path,uploaded_by,size_bytes,status)
    values (${id},${org},'Limits video',${"test/" + id},'test',1,'uploaded')`
  return id
}
async function analyze(org: string, videoId: string, limits: LimitPolicy) {
  return scoped(org, async (db) => {
    await assertAnalysisAdmission(db, { policy: limits })
    const [run] = await db.db.insert(schema.analysisRuns).values({
      orgId: org, videoId, pipelineVersion: "limits-test", status: "queued",
    }).returning()
    return run
  })
}

describe.skipIf(!process.env.DATABASE_URL)("usage limits against Postgres", () => {
  beforeEach(() => resetRateLimitCacheForTests())
  afterAll(async () => {
    for (const id of organizations) {
      await admin`delete from recording_deletions where org_id=${id}`
      await admin`delete from analysis_runs where org_id=${id}`
      await admin`delete from videos where org_id=${id}`
      await admin`delete from orgs where id=${id}`
    }
    await Promise.all([admin.end(), web.end()])
  })

  it("enforces the storage cap outside preview, and stops counting cleaned failed uploads", async () => {
    const limits = policy({ JAMS_LIMIT_ORG_STORAGE_BYTES: "100" })
    const org = await newOrg()
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => upload(org, 60, limits)))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 429, code: "storage" })
    }
    const kept = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>

    // A failed upload still reserves its bytes until the watchdog verified its blobs are gone.
    await admin`update videos set status='failed' where id=${kept.value.id}`
    await expect(upload(org, 60, limits)).rejects.toMatchObject({ status: 429 })
    await admin`update videos set upload_sources_cleaned_at=now() where id=${kept.value.id}`
    await expect(upload(org, 60, limits)).resolves.toMatchObject({ sizeBytes: 60 })
  })

  it("rejects a recording over the per-recording size or duration limit before any quota", async () => {
    const limits = policy({ JAMS_LIMIT_UPLOAD_MAX_BYTES: "50", JAMS_LIMIT_UPLOAD_MAX_DURATION_MS: "1000" })
    const org = await newOrg()
    await expect(upload(org, 51, limits)).rejects.toMatchObject({ status: 413 })
    await expect(
      scoped(org, (db) => assertUploadAdmission(db, 10, { policy: limits, durationMs: 1001 }))
    ).rejects.toMatchObject({ status: 400 })
  })

  it("trips the global daily upload breaker across organizations", async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    await upload(orgA, 1000, policy({}))
    // Other suites add and remove rows concurrently, but this org's 1000 bytes stay counted, so a
    // breaker at 1000 bytes must refuse even one more byte from anyone.
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const [{ bytes }] = await admin<{ bytes: string }[]>`select jams_global_upload_bytes_since(${since}::timestamptz) as bytes`
    expect(Number(bytes)).toBeGreaterThanOrEqual(1000)
    const limits = policy({ JAMS_LIMIT_GLOBAL_UPLOAD_BYTES_PER_DAY: "1000" })
    const error = await upload(orgB, 1, limits).catch((e) => e)
    expect(error).toMatchObject({ status: 429, code: "global_upload", retryAfterSeconds: 3600 })
  })

  it("counts runs in a rolling window, including runs of deleted recordings", async () => {
    const limits = policy({
      JAMS_LIMIT_ORG_ANALYSES_PER_WINDOW: "2",
      JAMS_LIMIT_ORG_ANALYSIS_WINDOW_SECONDS: "3600",
    })
    const org = await newOrg()
    const video = await videoFor(org)
    await analyze(org, video, limits)
    await analyze(org, video, limits)
    await admin`update analysis_runs set status='succeeded' where org_id=${org}`
    const error = await analyze(org, video, limits).catch((e) => e)
    expect(error).toMatchObject({ status: 429, code: "analysis_window" })
    expect(error.retryAfterSeconds).toBeGreaterThan(3500)
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(3600)

    // Once the runs age out of the window, work is admitted again...
    await admin`update analysis_runs set created_at = now() - interval '2 hours' where org_id=${org}`
    await expect(analyze(org, video, limits)).resolves.toBeTruthy()
    await admin`update analysis_runs set status='succeeded' where org_id=${org}`

    // ...but deleting a recording does not hand its runs back.
    await admin`insert into recording_deletions (video_id, org_id, run_ids, analysis_count, reserved_bytes)
      values (${randomUUID()}, ${org}, '[]'::jsonb, 1, 0)`
    await expect(analyze(org, video, limits)).rejects.toMatchObject({ code: "analysis_window" })
  })

  it("serializes the per-organization active cap outside preview", async () => {
    const limits = policy({ JAMS_LIMIT_ORG_ACTIVE_ANALYSES: "2" })
    const org = await newOrg()
    const video = await videoFor(org)
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => analyze(org, video, limits)))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2)
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({ status: 429, code: "active_analyses", retryAfterSeconds: 60 })
      }
    }
  })

  it("lets the web role count in-flight work across organizations it cannot read", async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    const video = await videoFor(orgA)
    for (let i = 0; i < 3; i++) {
      await admin`insert into analysis_runs (org_id, video_id, pipeline_version, status)
        values (${orgA}, ${video}, 'limits-test', 'queued')`
    }
    const seen = await scoped(orgB, async (db) => {
      const visible = await db.db.execute(
        sql`select count(*)::int as n from analysis_runs where org_id = ${orgA}`
      )
      const global = await db.db.execute(sql`select jams_global_active_analysis_count()::int as n`)
      return { visible: Number(visible[0].n), global: Number(global[0].n) }
    })
    expect(seen.visible).toBe(0)
    expect(seen.global).toBeGreaterThanOrEqual(3)

    // With the breaker at (or below) what is already in flight, new work is refused.
    const error = await analyze(orgB, await videoFor(orgB), policy({ JAMS_LIMIT_GLOBAL_ACTIVE_ANALYSES: "3" })).catch((e) => e)
    expect(error).toMatchObject({ status: 429, code: "global_active_analyses", retryAfterSeconds: 300 })
  })

  it("never admits more concurrent requests than a rate limit allows, across connections", async () => {
    const limits = policy({ JAMS_RATE_ANALYSIS_CREATE: "3/60" })
    const subject = `user:${randomUUID()}`
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit("analysis_create", subject, { policy: limits }))
    )
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3)

    // Counters are keyed by hash only, and the watchdog purge removes ended windows.
    const rows = await admin<{ bucket: string }[]>`select bucket from rate_limit_counters`
    expect(rows.some((row) => row.bucket.includes(subject))).toBe(false)
    expect(await purgeExpiredRateLimitCounters(new Date(Date.now() + 61_000))).toBeGreaterThanOrEqual(1)
  })
})
