import { sql } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { POST as completeVideo } from "@/app/api/videos/[id]/complete/route"
import { POST as createVideo } from "@/app/api/videos/route"
import { videos } from "@/db/schema"

type VideoRow = typeof videos.$inferSelect
type InsertValues = Record<string, unknown>
type UpdateValues = Record<string, unknown>

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status = 401
  }

  return {
    blobStats: vi.fn(),
    context: null as unknown,
    mintReadSas: vi.fn(),
    mintUploadSas: vi.fn(),
    MockUnauthorizedError,
  }
})

vi.mock("@/lib/blob", () => ({
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
    mocks.blobStats.mockResolvedValue({
      exists: true,
      sizeBytes: 9,
      contentType: "video/mp4",
    })

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
})
