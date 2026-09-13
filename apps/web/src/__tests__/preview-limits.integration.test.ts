// @vitest-environment node
import { randomUUID } from "node:crypto"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as schema from "@/db/schema"
import { assertAnalysisAdmission, assertUploadAdmission } from "@/lib/preview-limits"
import { bindOrgToTransaction, type OrgContext } from "@/lib/with-org"

const admin = postgres(process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams", { max: 2 })
const web = postgres(process.env.DATABASE_URL_WEB ?? "postgresql://jams_web:jams_web@localhost:5432/jams", { max: 6 })
const database = drizzle(web, { schema })
const organizations: string[] = []
async function newOrg() {
  const id = `preview_limits_${randomUUID()}`
  await admin`insert into orgs (id,name) values (${id},'Limits test')`
  organizations.push(id)
  return id
}
async function scoped<T>(org: string, fn: (db: OrgContext["scopedDb"]) => Promise<T>) {
  return database.transaction(async (tx) => fn(await bindOrgToTransaction(tx, org)))
}
async function upload(org: string, bytes: number) {
  return scoped(org, async (db) => {
    await assertUploadAdmission(db, bytes)
    const [video] = await db.db.insert(schema.videos).values({
      orgId: org, title: "Reserved upload", blobPath: `test/${randomUUID()}`,
      uploadedBy: "test", sizeBytes: bytes, status: "uploading",
    }).returning()
    return video
  })
}
async function analyze(org: string, videoId: string) {
  return scoped(org, async (db) => {
    await assertAnalysisAdmission(db)
    return db.db.insert(schema.analysisRuns).values({
      orgId: org, videoId, pipelineVersion: "limits-test", status: "queued",
    }).returning()
  })
}

describe.skipIf(!process.env.DATABASE_URL)("preview admission against Postgres", () => {
  beforeEach(() => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_test")
    vi.stubEnv("JAMS_PREVIEW_MAX_STORAGE_BYTES", "100")
    vi.stubEnv("JAMS_PREVIEW_MAX_ANALYSES", "3")
    vi.stubEnv("JAMS_PREVIEW_MAX_ACTIVE_RUNS", "1")
  })
  afterEach(() => vi.unstubAllEnvs())
  afterAll(async () => {
    for (const id of organizations) {
      await admin`delete from analysis_runs where org_id=${id}`
      await admin`delete from videos where org_id=${id}`
      await admin`delete from orgs where id=${id}`
    }
    await Promise.all([admin.end(), web.end()])
  })

  it("serializes concurrent reservations and isolates tenants", async () => {
    const org = await newOrg()
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => upload(org, 60)))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    for (const r of results) if (r.status === "rejected") expect(r.reason.status).toBe(429)
    expect((await upload(await newOrg(), 100)).sizeBytes).toBe(100)
  })

  it("serializes active runs and counts completed runs toward total allowance", async () => {
    const org = await newOrg()
    const video = await upload(org, 10)
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => analyze(org, video.id)))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    for (const r of results) if (r.status === "rejected") expect(r.reason.status).toBe(429)
    await admin`update analysis_runs set status='succeeded' where org_id=${org}`
    await analyze(org, video.id)
    await admin`update analysis_runs set status='failed' where org_id=${org}`
    await analyze(org, video.id)
    await admin`update analysis_runs set status='failed' where org_id=${org}`
    await expect(analyze(org, video.id)).rejects.toMatchObject({ status: 429 })
  })

  it("releases a rolled-back reservation", async () => {
    const org = await newOrg()
    await expect(scoped(org, async (db) => {
      await assertUploadAdmission(db, 100)
      await db.db.insert(schema.videos).values({
        orgId: org, title: "Rollback", blobPath: "test/rollback", uploadedBy: "test", sizeBytes: 100,
      })
      throw new Error("rollback")
    })).rejects.toThrow("rollback")
    await expect(upload(org, 100)).resolves.toMatchObject({ sizeBytes: 100 })
  })

  it("fails closed on malformed configuration", async () => {
    const org = await newOrg()
    vi.stubEnv("JAMS_PREVIEW_MAX_STORAGE_BYTES", "oops")
    await expect(upload(org, 1)).rejects.toMatchObject({ status: 503 })
    const rows = await admin`select id from videos where org_id=${org}`
    expect(rows).toHaveLength(0)
  })

  it("reserves conservative space for legacy unknown-size rows", async () => {
    const org = await newOrg()
    await admin`insert into videos (org_id,title,blob_path,uploaded_by)
      values (${org},'Unknown size','test/unknown','test')`
    await expect(upload(org, 1)).rejects.toMatchObject({ status: 429 })
  })

  it("keeps superseded queued work in the active count", async () => {
    const org = await newOrg()
    const video = await upload(org, 10)
    const [active] = await analyze(org, video.id)
    const replacement = randomUUID()
    await admin`insert into analysis_runs (id,org_id,video_id,pipeline_version,status)
      values (${replacement},${org},${video.id},'test','succeeded')`
    await admin`update analysis_runs set superseded_by=${replacement} where id=${active.id}`
    await expect(analyze(org, video.id)).rejects.toThrow("concurrent analysis limit")
  })
})
