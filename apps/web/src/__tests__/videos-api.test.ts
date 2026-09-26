import { sql } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { POST as completeVideo } from "@/app/api/videos/[id]/complete/route"
import { POST as createVideo } from "@/app/api/videos/route"
import { videos } from "@/db/schema"
import * as previewLimits from "@/lib/preview-limits"
import { BlobFinalizationError } from "@/lib/blob"

type VideoRow = typeof videos.$inferSelect
type InsertValues = Record<string, unknown>
type UpdateValues = Record<string, unknown>

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status = 401
  }

  return {
    blobStats: vi.fn(),
    finalizeBlob: vi.fn(),
    context: null as unknown,
    mintReadSas: vi.fn(),
    mintUploadSas: vi.fn(),
    MockUnauthorizedError,
  }
})

vi.mock("@/lib/blob", () => ({
  BlobFinalizationError: class extends Error {
    constructor(message: string, readonly status: number, readonly rejected = false) { super(message) }
  },
  finalizeBlob: mocks.finalizeBlob,
  blobStats: mocks.blobStats,
  mintReadSas: mocks.mintReadSas,
  mintUploadSas: mocks.mintUploadSas,
}))

vi.mock("@/lib/with-org", () => ({
  UnauthorizedError: mocks.MockUnauthorizedError,
  isUnauthorized: (error: unknown) => error instanceof mocks.MockUnauthorizedError,
  withOrg: vi.fn((handler: (context: unknown) => unknown) =>
    handler(mocks.context)
  ),
}))

class SelectBuilder {
  constructor(private readonly db: MockDb) {}

  from() {
    return this
  }

  for() { return this }

  leftJoin() {
    return this
  }

  where() {
    return this
  }

  orderBy() {
    return Promise.resolve(this.db.nextSelect())
  }

  limit() {
    return Promise.resolve(this.db.nextSelect())
  }
}

class InsertBuilder {
  private input: InsertValues = {}

  constructor(private readonly db: MockDb) {}

  values(input: InsertValues) {
    this.input = input
    this.db.inserts.push(input)
    return this
  }

  returning() {
    return Promise.resolve([this.db.onInsert(this.input)])
  }
}

class UpdateBuilder {
  private input: UpdateValues = {}

  constructor(private readonly db: MockDb) {}

  set(input: UpdateValues) {
    this.input = input
    this.db.updates.push(input)
    return this
  }

  where() {
    return this
  }

  returning() {
    return Promise.resolve([this.db.onUpdate(this.input)])
  }
}

class MockDb {
  readonly inserts: InsertValues[] = []
  readonly updates: UpdateValues[] = []
  readonly selectRows: unknown[][] = []

  onInsert: (input: InsertValues) => unknown = (input) => input
  onUpdate: (input: UpdateValues) => unknown = (input) => input

  select() {
    return new SelectBuilder(this)
  }

  insert() {
    return new InsertBuilder(this)
  }

  update() {
    return new UpdateBuilder(this)
  }

  nextSelect() {
    return this.selectRows.shift() ?? []
  }
}

function videoRow(overrides: Partial<VideoRow> = {}): VideoRow {
  return {
    id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
    orgId: "org_test",
    taskId: null,
    title: "Checkout flow",
    blobPath: "org_test/8c980f72-91f2-4778-bf2c-57c6f72f9b40/original.mp4",
    posterBlobPath: "org_test/8c980f72-91f2-4778-bf2c-57c6f72f9b40/poster.jpg",
    sizeBytes: 10,
    contentType: "video/mp4",
    durationMs: null,
    width: null,
    height: null,
    fps: null,
    hasAudio: null,
    subjectLabel: null,
    variantLabel: null,
    status: "uploading",
    uploadedBy: "user_test",
    archivedAt: null,
    uploadSourcesCleanedAt: null,
    createdAt: new Date("2026-07-17T12:00:00.000Z"),
    ...overrides,
  }
}

function installContext(db: MockDb) {
  mocks.context = {
    userId: "user_test",
    orgId: "org_test",
    scopedDb: {
      orgId: "org_test",
      db,
      orgFilter: vi.fn((_table: unknown, extra?: unknown) => extra ?? sql`org_id`),
    },
  }
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://jams.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

describe("videos API route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Quota logic is covered against real Postgres (preview-limits.integration.test.ts).
    vi.spyOn(previewLimits, "assertUploadAdmission").mockResolvedValue(undefined)
    mocks.finalizeBlob.mockImplementation(async (path: string) => ({ blobPath: `${path}.finalized` }))
    mocks.blobStats.mockResolvedValue({
      exists: true,
      sizeBytes: 10,
      contentType: "video/mp4",
    })
    mocks.mintUploadSas.mockImplementation((blobPath: string) =>
      Promise.resolve({
        url: `https://storage.test/videos/${blobPath}?sas`,
        expiresAt: "2026-07-17T12:15:00.000Z",
      })
    )
  })

  it("rejects exhausted admission before inserting or issuing SAS credentials", async () => {
    const db = new MockDb()
    installContext(db)
    const guard = vi.spyOn(previewLimits, "assertUploadAdmission")
      .mockRejectedValueOnce(new previewLimits.PreviewLimitError("Preview storage limit reached"))
    try {
      const response = await createVideo(jsonRequest("/api/videos", {
        title: "Over limit", filename: "test.mp4", content_type: "video/mp4", size_bytes: 10,
      }))
      expect(response.status).toBe(429)
      expect(db.inserts).toHaveLength(0)
      expect(mocks.mintUploadSas).not.toHaveBeenCalled()
    } finally { guard.mockRestore() }
  })

  it("creates an org-scoped uploading row and mints upload SAS URLs", async () => {
    const db = new MockDb()
    db.onInsert = (input) =>
      videoRow({
        ...input,
        createdAt: new Date("2026-07-17T12:00:00.000Z"),
      } as Partial<VideoRow>)
    installContext(db)

    const response = await createVideo(
      jsonRequest("/api/videos", {
        title: "Checkout flow",
        filename: "checkout.mp4",
        content_type: "video/mp4",
        size_bytes: 10,
        subject_label: "Participant 3",
      })
    )
    const body = (await response.json()) as {
      video_id: string
      upload: { url: string }
      poster_upload: { url: string }
    }

    expect(response.status).toBe(201)
    expect(db.inserts[0]).toMatchObject({
      orgId: "org_test",
      uploadedBy: "user_test",
      status: "uploading",
      blobPath: `org_test/${body.video_id}/original.mp4`,
      posterBlobPath: `org_test/${body.video_id}/poster.jpg`,
    })
    expect(body.upload.url).toContain(`/org_test/${body.video_id}/original.mp4?`)
    expect(body.poster_upload.url).toContain(
      `/org_test/${body.video_id}/poster.jpg?`
    )
  })

  it("does not mark a video failed when completion blob size verification fails", async () => {
    const db = new MockDb()
    db.selectRows.push([videoRow({ sizeBytes: 10 })])
    installContext(db)
    mocks.finalizeBlob.mockRejectedValueOnce(new BlobFinalizationError("Size mismatch", 400))

    const response = await completeVideo(
      jsonRequest(
        "/api/videos/8c980f72-91f2-4778-bf2c-57c6f72f9b40/complete",
        {
          duration_ms: 1_000,
          width: 1280,
          height: 720,
          has_audio: true,
          poster_uploaded: false,
        }
      ),
      {
        params: Promise.resolve({
          id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
        }),
      }
    )

    expect(response.status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })

  it("marks the video failed when finalization rejected and deleted the uploaded blob", async () => {
    const db = new MockDb()
    db.selectRows.push([videoRow({ sizeBytes: 10 })])
    installContext(db)
    mocks.finalizeBlob.mockRejectedValueOnce(
      new BlobFinalizationError("Uploaded blob size does not match requested size", 400, true)
    )

    const response = await completeVideo(
      jsonRequest("/api/videos/8c980f72-91f2-4778-bf2c-57c6f72f9b40/complete", {
          duration_ms: 1_000,
          width: 1280,
          height: 720,
          has_audio: true,
          poster_uploaded: true,
        }),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )

    expect(response.status).toBe(400)
    expect(db.updates).toEqual([{ status: "failed" }])
    expect(mocks.finalizeBlob).toHaveBeenCalledWith(
      "org_test/8c980f72-91f2-4778-bf2c-57c6f72f9b40/original.mp4",
      10,
      { maxBytes: 2 * 1024 * 1024 * 1024 }
    )
  })

  it("finalizes without a poster when the poster breaks its size limit", async () => {
    const db = new MockDb()
    db.selectRows.push([videoRow({ sizeBytes: 10 })])
    db.onUpdate = (input) => videoRow({ ...(input as Partial<VideoRow>) })
    installContext(db)
    mocks.finalizeBlob
      .mockImplementationOnce(async (path: string) => ({ blobPath: `${path}.finalized` }))
      .mockRejectedValueOnce(new BlobFinalizationError("Uploaded blob is larger than the upload limit", 400, true))

    const response = await completeVideo(
      jsonRequest("/api/videos/8c980f72-91f2-4778-bf2c-57c6f72f9b40/complete", {
          duration_ms: 1_000,
          width: 1280,
          height: 720,
          has_audio: true,
          poster_uploaded: true,
        }),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )

    expect(response.status).toBe(200)
    expect(mocks.finalizeBlob).toHaveBeenLastCalledWith(
      "org_test/8c980f72-91f2-4778-bf2c-57c6f72f9b40/poster.jpg",
      null,
      { maxBytes: 5 * 1024 * 1024 }
    )
    expect(db.updates).toEqual([
      expect.objectContaining({ status: "uploaded", posterBlobPath: null }),
    ])
  })

  it("refuses a completion whose measured duration is over the limit and fails the video", async () => {
    const db = new MockDb()
    db.selectRows.push([videoRow({ sizeBytes: 10 })])
    installContext(db)

    const response = await completeVideo(
      jsonRequest("/api/videos/8c980f72-91f2-4778-bf2c-57c6f72f9b40/complete", {
        duration_ms: 20 * 60 * 1000 + 1,
        width: 1280,
        height: 720,
        has_audio: true,
        poster_uploaded: false,
      }),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Recording is longer than the 20-minute limit" })
    expect(db.updates).toEqual([{ status: "failed" }])
    expect(mocks.finalizeBlob).not.toHaveBeenCalled()
  })

  it("passes the declared duration to upload admission", async () => {
    const db = new MockDb()
    db.onInsert = (input) => videoRow({ ...(input as Partial<VideoRow>) })
    installContext(db)
    const guard = vi.spyOn(previewLimits, "assertUploadAdmission")
    await createVideo(jsonRequest("/api/videos", {
      title: "Long", filename: "long.mp4", content_type: "video/mp4", size_bytes: 10,
      duration_ms: 90_000,
    }))
    expect(guard).toHaveBeenCalledWith(expect.anything(), 10, { durationMs: 90_000 })
  })

  it("sets failed status only on explicit failed completion bodies", async () => {
    const db = new MockDb()
    db.selectRows.push([videoRow()])
    db.onUpdate = (input) => videoRow({ status: input.status as VideoRow["status"] })
    installContext(db)

    const response = await completeVideo(
      jsonRequest(
        "/api/videos/8c980f72-91f2-4778-bf2c-57c6f72f9b40/complete",
        { failed: true }
      ),
      {
        params: Promise.resolve({
          id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
        }),
      }
    )
    const body = (await response.json()) as { video: { status: string } }

    expect(response.status).toBe(200)
    expect(db.updates).toEqual([{ status: "failed" }])
    expect(body.video.status).toBe("failed")
    expect(mocks.blobStats).not.toHaveBeenCalled()
  })

  it("does not allow a late failure to demote a finalized video", async () => {
    const db = new MockDb()
    db.selectRows.push([videoRow({ status: "uploaded" })])
    installContext(db)
    const response = await completeVideo(jsonRequest("/api/videos/id/complete", { failed: true }), {
      params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }),
    })
    expect(response.status).toBe(409)
    expect(db.updates).toHaveLength(0)
    expect(mocks.finalizeBlob).not.toHaveBeenCalled()
  })

  it.each([false, true])("handles repeated completion with changed metadata=%s", async (changed) => {
    const db = new MockDb()
    db.selectRows.push([videoRow({ status: "uploaded", durationMs: 1000, width: 640,
      height: 480, hasAudio: true, posterBlobPath: null })])
    installContext(db)
    const response = await completeVideo(jsonRequest("/api/videos/id/complete", {
      duration_ms: changed ? 2000 : 1000, width: 640, height: 480, has_audio: true,
      poster_uploaded: false,
    }), { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) })
    expect(response.status).toBe(changed ? 409 : 200)
    expect(db.updates).toHaveLength(0)
    expect(mocks.finalizeBlob).not.toHaveBeenCalled()
  })
})
