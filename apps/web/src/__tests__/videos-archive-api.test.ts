import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { PATCH as patchVideo } from "@/app/api/videos/[id]/route"
import { GET as listVideos } from "@/app/api/videos/route"

const mocks = vi.hoisted(() => ({ context: null as unknown }))

vi.mock("@/lib/with-org", () => ({
  UnauthorizedError: class extends Error {},
  isUnauthorized: () => false,
  withOrg: vi.fn((handler: (context: unknown) => unknown) => handler(mocks.context)),
}))

// The [id] route also carries DELETE; these are irrelevant here and pull in blob storage.
vi.mock("@/lib/recording-deletion", () => ({ requestRecordingDeletion: vi.fn() }))
vi.mock("@/lib/recording-cleanup", () => ({ reconcileRecordingCleanup: vi.fn() }))
vi.mock("@/lib/blob", () => ({ mintUploadSas: vi.fn(), mintReadSas: vi.fn() }))

const VIDEO_ID = "8c980f72-91f2-4778-bf2c-57c6f72f9b40"
const dialect = new PgDialect()

/** A select builder that is awaitable at any point in the chain, and records every WHERE clause. */
class RecordingSelect {
  constructor(private readonly db: FakeDb) {}
  from() { return this }
  leftJoin() { return this }
  orderBy() { return this }
  limit() { return this }
  where(condition: unknown) {
    this.db.wheres.push(condition)
    return this
  }
  then<T>(resolve: (rows: unknown[]) => T) {
    return Promise.resolve(this.db.selectResults.shift() ?? []).then(resolve)
  }
}

class FakeDb {
  readonly wheres: unknown[] = []
  readonly updates: Record<string, unknown>[] = []
  selectResults: unknown[][] = []
  updateResult: unknown = undefined

  select() { return new RecordingSelect(this) }

  update() {
    const builder = {
      set: (values: Record<string, unknown>) => {
        this.updates.push(values)
        return builder
      },
      where: () => builder,
      returning: () => Promise.resolve(this.updateResult === undefined ? [] : [this.updateResult]),
    }
    return builder
  }
}

function install(db: FakeDb) {
  mocks.context = {
    userId: "user_test",
    orgId: "org_test",
    scopedDb: {
      orgId: "org_test",
      db,
      orgFilter: (_table: unknown, extra?: unknown) => extra ?? sql`org_id = 'org_test'`,
    },
  }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function patch(id: string, body: unknown) {
  return patchVideo(
    new Request(`http://jams.test/api/videos/${id}`, {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    params(id)
  )
}

describe("PATCH /api/videos/[id] (archive)", () => {
  let db: FakeDb

  beforeEach(() => {
    db = new FakeDb()
    install(db)
  })

  it("archives a recording and reports when", async () => {
    db.updateResult = { id: VIDEO_ID, archivedAt: new Date("2026-09-19T10:00:00.000Z") }

    const response = await patch(VIDEO_ID, { archived: true })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      video: { id: VIDEO_ID, archived_at: "2026-09-19T10:00:00.000Z" },
    })
    // A SQL expression rather than a client date: re-archiving must keep the original timestamp.
    const value = db.updates[0].archivedAt as { queryChunks?: unknown[] }
    expect(value).not.toBeNull()
    expect(dialect.sqlToQuery(value as ReturnType<typeof sql>).sql).toMatch(/coalesce\(/i)
  })

  it("restores a recording by clearing the timestamp", async () => {
    db.updateResult = { id: VIDEO_ID, archivedAt: null }

    const response = await patch(VIDEO_ID, { archived: false })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ video: { id: VIDEO_ID, archived_at: null } })
    expect(db.updates[0]).toEqual({ archivedAt: null })
  })

  it("is a 404 when the recording is not in this organization, or is already gone", async () => {
    db.updateResult = undefined // the org-scoped UPDATE matched no row

    const response = await patch(VIDEO_ID, { archived: true })

    expect(response.status).toBe(404)
  })

  it("rejects a malformed id without touching the database", async () => {
    const response = await patch("not-a-uuid", { archived: true })

    expect(response.status).toBe(404)
    expect(db.updates).toHaveLength(0)
  })

  it.each([
    ["a non-boolean flag", { archived: "yes" }],
    ["a missing flag", {}],
    ["unrelated fields only", { title: "renamed" }],
  ])("rejects %s", async (_name, body) => {
    const response = await patch(VIDEO_ID, body)

    expect(response.status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })

  it("rejects a body that is not JSON", async () => {
    const response = await patch(VIDEO_ID, "{oops")

    expect(response.status).toBe(400)
    expect(db.updates).toHaveLength(0)
  })

  it("does not let PATCH rename or otherwise edit the recording", async () => {
    db.updateResult = { id: VIDEO_ID, archivedAt: null }

    await patch(VIDEO_ID, { archived: false, title: "hijacked", orgId: "org_other" })

    // Only the archive column is ever written, whatever else the client sends.
    expect(Object.keys(db.updates[0])).toEqual(["archivedAt"])
  })
})

describe("GET /api/videos (archived filter)", () => {
  let db: FakeDb

  beforeEach(() => {
    db = new FakeDb()
    // 1st select: the list, 2nd: the archived count. No rows, so no run lookup happens.
    db.selectResults = [[], [{ value: 3 }]]
    install(db)
  })

  const list = (query = "") =>
    listVideos(new NextRequest(`http://jams.test/api/videos${query}`))

  function listWhere() {
    return dialect.sqlToQuery(db.wheres[0] as ReturnType<typeof sql>).sql
  }

  it("hides archived recordings by default", async () => {
    const response = await list()

    expect(response.status).toBe(200)
    expect(listWhere()).toMatch(/"archived_at" is null/i)
  })

  it("shows only archived recordings when asked", async () => {
    await list("?archived=archived")

    expect(listWhere()).toMatch(/"archived_at" is not null/i)
  })

  it("shows everything with archived=all", async () => {
    await list("?archived=all")

    expect(listWhere()).not.toMatch(/archived_at/i)
  })

  it("rejects an unknown archived value instead of silently using the default", async () => {
    const response = await list("?archived=sometimes")

    expect(response.status).toBe(400)
  })

  it("reports how many recordings are archived, independent of the current view", async () => {
    const response = await list()

    expect((await response.json()).archived_count).toBe(3)
  })
})
