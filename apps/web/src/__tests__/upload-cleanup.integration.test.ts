// @vitest-environment node
import { randomUUID } from "node:crypto"
import postgres from "postgres"
import { afterAll, describe, expect, it, vi } from "vitest"

import { sweepStaleUploads, uploadSourcePaths } from "@/lib/upload-cleanup"

const admin = postgres(process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams", { max: 2 })
const organizations: string[] = []

async function newOrg() {
  const id = `upload_cleanup_${randomUUID()}`
  await admin`insert into orgs (id,name) values (${id},'Upload cleanup test')`
  organizations.push(id)
  return id
}

async function video(org: string, input: { status: string; ageMinutes: number; finalized?: boolean }) {
  const id = randomUUID()
  const base = `${org}/${id}`
  const blobPath = input.finalized ? `${base}/finalized/${randomUUID()}/original.mp4` : `${base}/original.mp4`
  const poster = input.finalized ? `${base}/finalized/${randomUUID()}/poster.jpg` : `${base}/poster.jpg`
  await admin`insert into videos (id, org_id, title, blob_path, poster_blob_path, uploaded_by, size_bytes,
      content_type, status, created_at)
    values (${id}, ${org}, 'Cleanup', ${blobPath}, ${poster}, 'test', 10, 'video/mp4', ${input.status},
      now() - make_interval(mins => ${input.ageMinutes}))`
  return { id, base, blobPath, poster }
}

async function row(id: string) {
  const [found] = await admin<{ status: string; cleaned: Date | null; poster: string | null }[]>`
    select status, upload_sources_cleaned_at as cleaned, poster_blob_path as poster from videos where id=${id}`
  return found
}

describe("upload source paths", () => {
  it("never includes a finalized recording's current paths", () => {
    const paths = uploadSourcePaths({
      id: "v", orgId: "o", status: "uploaded",
      blobPath: "o/v/finalized/f/original.mov", posterBlobPath: "o/v/finalized/g/poster.jpg",
    })
    expect(paths).toEqual(["o/v/original.mov", "o/v/poster.jpg"])
  })
})

describe.skipIf(!process.env.DATABASE_URL)("stale upload sweep against Postgres", () => {
  afterAll(async () => {
    for (const id of organizations) {
      await admin`delete from videos where org_id=${id}`
      await admin`delete from orgs where id=${id}`
    }
    await admin.end()
  })

  it("fails abandoned uploads and deletes client upload paths only after the SAS expired", async () => {
    const org = await newOrg()
    const abandoned = await video(org, { status: "uploading", ageMinutes: 90 })
    const inFlight = await video(org, { status: "uploading", ageMinutes: 10 })
    const finalized = await video(org, { status: "uploaded", ageMinutes: 30, finalized: true })
    const fresh = await video(org, { status: "uploaded", ageMinutes: 5, finalized: true })
    const deleted: string[] = []
    const deleteBlob = vi.fn(async (path: string) => { deleted.push(path) })

    // Other suites share this database, so assert on this org's rows, not on global counts.
    for (let i = 0; i < 20; i++) {
      const result = await sweepStaleUploads({ staleUploadMinutes: 60, deleteBlob, batchSize: 500 })
      if (result.cleanedCount === 0) break
    }

    expect((await row(abandoned.id)).status).toBe("failed")
    expect((await row(abandoned.id)).cleaned).not.toBeNull()
    expect((await row(abandoned.id)).poster).toBeNull()
    expect(deleted).toEqual(expect.arrayContaining([`${abandoned.base}/original.mp4`, `${abandoned.base}/poster.jpg`]))

    expect(await row(inFlight.id)).toMatchObject({ status: "uploading", cleaned: null })

    expect((await row(finalized.id)).cleaned).not.toBeNull()
    expect((await row(finalized.id)).poster).toBe(finalized.poster)
    expect(deleted).toEqual(expect.arrayContaining([`${finalized.base}/original.mp4`, `${finalized.base}/poster.jpg`]))
    expect(deleted).not.toContain(finalized.blobPath)
    expect(deleted).not.toContain(finalized.poster)

    expect((await row(fresh.id)).cleaned).toBeNull()
    expect(deleted.some((path) => path.startsWith(fresh.base))).toBe(false)
  })

  it("leaves the row for the next sweep when storage deletion fails", async () => {
    const org = await newOrg()
    const target = await video(org, { status: "failed", ageMinutes: 45 })
    const deleteBlob = vi.fn(async (path: string) => {
      if (path.startsWith(target.base)) throw new Error("storage unavailable")
    })
    await sweepStaleUploads({ staleUploadMinutes: 60, deleteBlob, batchSize: 500 })
    expect((await row(target.id)).cleaned).toBeNull()
  })
})
