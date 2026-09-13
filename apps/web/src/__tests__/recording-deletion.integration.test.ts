// @vitest-environment node
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import * as schema from "@/db/schema"
import { requestRecordingDeletion } from "@/lib/recording-deletion"
import { reconcileRecordingCleanup } from "@/lib/recording-cleanup"
import { assertAnalysisAdmission, assertUploadAdmission } from "@/lib/preview-limits"
import { bindOrgToTransaction, type OrgContext } from "@/lib/with-org"

const mocks = vi.hoisted(() => ({ cleanup: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/blob", () => ({ cleanupRecordingBlobs: mocks.cleanup }))

const admin = postgres(process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams", { max: 3 })
const web = postgres(process.env.DATABASE_URL_WEB ?? "postgresql://jams_web:jams_web@localhost:5432/jams", { max: 6 })
const database = drizzle(web, { schema })
const orgs: string[] = []
async function fixture(runCount = 2) {
  const orgId = `deletion_${randomUUID()}`
  const videoId = randomUUID()
  const runIds = Array.from({ length: runCount }, () => randomUUID())
  orgs.push(orgId)
  await admin`insert into orgs (id,name) values (${orgId},'Deletion test')`
  await admin`insert into videos (id,org_id,title,blob_path,uploaded_by,size_bytes,status)
    values (${videoId},${orgId},'Recording',${`${orgId}/${videoId}/original.mp4`},'test',100,'uploaded')`
  for (const id of runIds) {
    await admin`insert into analysis_runs (id,org_id,video_id,pipeline_version,status)
      values (${id},${orgId},${videoId},'test','running')`
    await admin`insert into share_links (run_id,org_id,token,expires_at,created_by)
      values (${id},${orgId},${randomUUID()},now()+interval '1 day','test')`
    await admin`insert into analysis_artifacts (run_id,org_id,kind,blob_path)
      values (${id},${orgId},'transcript',${`runs/${id}/attempts/1/transcript.json`})`
    await admin`insert into analysis_dispatch_outbox (run_id,org_id) values (${id},${orgId})`
  }
  return { orgId, videoId, runIds }
}
async function scoped<T>(orgId: string, fn: (db: OrgContext["scopedDb"]) => Promise<T>) {
  return database.transaction(async (tx) => fn(await bindOrgToTransaction(tx, orgId)))
}

describe.skipIf(!process.env.DATABASE_URL)("recording deletion with PostgreSQL RLS", () => {
  afterEach(() => { vi.unstubAllEnvs(); mocks.cleanup.mockReset().mockResolvedValue(undefined) })
  afterAll(async () => {
    for (const orgId of orgs) {
      await admin`delete from videos where org_id=${orgId}`
      await admin`delete from recording_deletions where org_id=${orgId}`
      await admin`delete from orgs where id=${orgId}`
    }
    await Promise.all([admin.end(), web.end()])
  })

  it("revokes relational access atomically and records all runs exactly once", async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      scoped(f.orgId, (db) => requestRecordingDeletion(db, f.videoId))))
    for (const result of results) expect(result.analysisCount).toBe(2)
    const [job] = await admin`select * from recording_deletions where video_id=${f.videoId}`
    expect(job.run_ids.sort()).toEqual(f.runIds.sort())
    for (const table of ["videos", "analysis_runs", "share_links", "analysis_artifacts", "analysis_dispatch_outbox"]) {
      const rows = await admin`select * from ${admin(table)} where org_id=${f.orgId}`
      expect(rows).toHaveLength(0)
    }
    expect(mocks.cleanup).not.toHaveBeenCalled() // no storage side effects before commit
  })

  it("isolates recordings and deletion records by tenant, including RLS without filters", async () => {
    const own = await fixture(0)
    const foreign = await fixture(0)
    await expect(scoped(own.orgId, (db) => requestRecordingDeletion(db, foreign.videoId)))
      .rejects.toMatchObject({ status: 404 })
    await scoped(foreign.orgId, (db) => requestRecordingDeletion(db, foreign.videoId))
    expect(await scoped(own.orgId, (db) => db.db.select().from(schema.recordingDeletions))).toEqual([])
    await expect(scoped(own.orgId, (db) => requestRecordingDeletion(db, foreign.videoId)))
      .rejects.toMatchObject({ status: 404 })
    await expect(scoped(own.orgId, (db) => db.db.insert(schema.recordingDeletions).values({
      videoId: randomUUID(), orgId: foreign.orgId, runIds: [], analysisCount: 0, reservedBytes: 0,
    }))).rejects.toThrow()
  })

  it("rolls back both cleanup intent and revocation on transaction failure", async () => {
    const f = await fixture()
    await expect(scoped(f.orgId, async (db) => {
      await requestRecordingDeletion(db, f.videoId)
      throw new Error("commit failed")
    })).rejects.toThrow("commit failed")
    expect(await admin`select id from share_links where org_id=${f.orgId}`).toHaveLength(2)
    expect(await admin`select video_id from recording_deletions where org_id=${f.orgId}`).toHaveLength(0)
  })

  it("retains consumed analyses and storage reservations through pending cleanup", async () => {
    const f = await fixture()
    await scoped(f.orgId, (db) => requestRecordingDeletion(db, f.videoId))
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_test")
    vi.stubEnv("JAMS_PREVIEW_MAX_ANALYSES", "2")
    vi.stubEnv("JAMS_PREVIEW_MAX_STORAGE_BYTES", "100")
    await expect(scoped(f.orgId, assertAnalysisAdmission)).rejects.toMatchObject({ status: 429 })
    await expect(scoped(f.orgId, (db) => assertUploadAdmission(db, 1))).rejects.toMatchObject({ status: 429 })
    await reconcileRecordingCleanup(f.videoId)
    const [pending] = await admin`select * from recording_deletions where video_id=${f.videoId}`
    expect(pending.last_verified_at).toBeNull()
    expect(pending.next_sweep_at.getTime()).toBeGreaterThan(Date.now())
    await admin`update recording_deletions set requested_at=now()-interval '16 minutes',
      next_sweep_at=now()-interval '1 minute' where video_id=${f.videoId}`
    await reconcileRecordingCleanup(f.videoId)
    await expect(scoped(f.orgId, (db) => assertUploadAdmission(db, 100))).resolves.toBeUndefined()
    await expect(scoped(f.orgId, assertAnalysisAdmission)).rejects.toMatchObject({ status: 429 })
  })

  it("retains retry intent after storage errors and keeps verifying for late writes", async () => {
    const f = await fixture(1)
    await scoped(f.orgId, (db) => requestRecordingDeletion(db, f.videoId))
    mocks.cleanup.mockRejectedValueOnce(new Error("private SAS must not be saved"))
    expect(await reconcileRecordingCleanup(f.videoId)).toEqual({ sweptCount: 0, failedCount: 1 })
    const [failed] = await admin`select * from recording_deletions where video_id=${f.videoId}`
    expect(failed.last_error).toBe("Storage cleanup needs retry")
    expect(failed.lease_token).toBeNull()
    await admin`update recording_deletions set requested_at=now()-interval '16 minutes',
      next_sweep_at=now()-interval '1 minute' where video_id=${f.videoId}`
    expect(await reconcileRecordingCleanup(f.videoId)).toEqual({ sweptCount: 1, failedCount: 0 })
    const [verified] = await admin`select * from recording_deletions where video_id=${f.videoId}`
    expect(verified.last_verified_at).toBeInstanceOf(Date)
    expect(verified.last_error).toBeNull()
    await admin`update recording_deletions set next_sweep_at=now()-interval '1 minute' where video_id=${f.videoId}`
    await reconcileRecordingCleanup(f.videoId)
    expect(mocks.cleanup).toHaveBeenCalledTimes(3)
    expect(mocks.cleanup).toHaveBeenLastCalledWith(f)
  })

  it("only admits one cleanup claimant while its lease is active", async () => {
    const f = await fixture(0)
    await scoped(f.orgId, (db) => requestRecordingDeletion(db, f.videoId))
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    mocks.cleanup.mockImplementationOnce(async () => { entered(); await gate })
    const first = reconcileRecordingCleanup(f.videoId)
    await started
    try {
      expect(await reconcileRecordingCleanup(f.videoId)).toEqual({ sweptCount: 0, failedCount: 0 })
    } finally { release() }
    await first
    expect(mocks.cleanup).toHaveBeenCalledTimes(1)
  })

  it("serializes analysis creation with deletion on the video row", async () => {
    const f = await fixture(0)
    const create = () => scoped(f.orgId, async (db) => {
      const [video] = await db.db.select().from(schema.videos)
        .where(db.orgFilter(schema.videos, eq(schema.videos.id, f.videoId))).for("update").limit(1)
      if (!video) return
      await assertAnalysisAdmission(db)
      await db.db.insert(schema.analysisRuns).values({
        videoId: f.videoId, orgId: f.orgId, pipelineVersion: "test",
      })
    })
    await Promise.all([create(), scoped(f.orgId, (db) => requestRecordingDeletion(db, f.videoId)), create()])
    expect(await admin`select id from analysis_runs where video_id=${f.videoId}`).toHaveLength(0)
    const [job] = await admin`select analysis_count, run_ids from recording_deletions where video_id=${f.videoId}`
    expect(job.analysis_count).toBe(job.run_ids.length)
  })

  it("reclaims an abandoned sweep and fences an obsolete claimant's completion", async () => {
    const f = await fixture(0)
    await scoped(f.orgId, (db) => requestRecordingDeletion(db, f.videoId))
    const stale = randomUUID()
    await admin`update recording_deletions set lease_token=${stale},
      lease_expires_at=now()-interval '1 minute' where video_id=${f.videoId}`
    const replacement = randomUUID()
    mocks.cleanup.mockImplementationOnce(async () => {
      const [claimed] = await admin`select lease_token from recording_deletions where video_id=${f.videoId}`
      expect(claimed.lease_token).not.toBe(stale)
      // Model a suspended process resuming after another claimant took over.
      await admin`update recording_deletions set lease_token=${replacement},
        lease_expires_at=now()+interval '5 minutes', last_error='New claimant state'
        where video_id=${f.videoId}`
    })
    await reconcileRecordingCleanup(f.videoId)
    const [job] = await admin`select lease_token,last_error from recording_deletions where video_id=${f.videoId}`
    expect(job.lease_token).toBe(replacement)
    expect(job.last_error).toBe("New claimant state")
  })
})
