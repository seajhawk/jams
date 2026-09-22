import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GET as listActive } from "@/app/api/analyses/route"

const mocks = vi.hoisted(() => ({ context: null as unknown }))

vi.mock("@/lib/with-org", () => ({
  UnauthorizedError: class extends Error {},
  isUnauthorized: () => false,
  withOrg: vi.fn((handler: (context: unknown) => unknown) => handler(mocks.context)),
}))

// POST in the same route module reaches for these; GET does not.
vi.mock("@/lib/analysis-dispatch", () => ({
  dispatchAnalysisRun: vi.fn(),
  recordDispatchIntent: vi.fn(),
}))
vi.mock("@/lib/preview-limits", () => ({ assertAnalysisAdmission: vi.fn() }))
vi.mock("@/lib/report-assembly", () => ({ getOrCreateDefaultProfile: vi.fn() }))

const dialect = new PgDialect()

const RUN = {
  id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
  videoId: "0e4cf0ea-1f2a-4f5e-9a55-2a9a6a3f1c77",
  config: {},
  configSource: null,
  pipelineVersion: "1.0.0",
  status: "running",
  stage: "transcription",
  progressPct: 40,
  stageDetail: "Transcribing narration",
  errorCode: null,
  attempt: 1,
  supersededBy: null,
  createdAt: new Date("2026-09-22T10:00:00.000Z"),
  updatedAt: new Date("2026-09-22T10:01:00.000Z"),
  startedAt: new Date("2026-09-22T10:00:30.000Z"),
  completedAt: null,
}

class FakeDb {
  wheres: unknown[] = []
  rows: unknown[] = []
  joined = false

  select() {
    const chain = {
      from: () => chain,
      leftJoin: () => {
        this.joined = true
        return chain
      },
      where: (condition: unknown) => {
        this.wheres.push(condition)
        return chain
      },
      orderBy: () => Promise.resolve(this.rows),
    }
    return chain
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

const list = (query: string) => listActive(new Request(`http://jams.test/api/analyses${query}`))

describe("GET /api/analyses?active=1", () => {
  let db: FakeDb

  beforeEach(() => {
    db = new FakeDb()
    install(db)
  })

  it("returns the runs still working, with the recording they belong to", async () => {
    db.rows = [{ run: RUN, videoTitle: "Checkout walkthrough" }]

    const response = await list("?active=1")

    expect(response.status).toBe(200)
    const { analyses } = (await response.json()) as { analyses: Record<string, unknown>[] }
    expect(analyses).toHaveLength(1)
    expect(analyses[0]).toMatchObject({
      id: RUN.id,
      video_id: RUN.videoId,
      video_title: "Checkout walkthrough",
      status: "running",
      progress_pct: 40,
      stage_detail: "Transcribing narration",
    })
  })

  it("asks only for queued and running work", async () => {
    await list("?active=1")

    const rendered = dialect.sqlToQuery(db.wheres[0] as ReturnType<typeof sql>)
    expect(rendered.sql).toMatch(/"status" in/i)
    expect(rendered.params).toEqual(expect.arrayContaining(["queued", "running"]))
    expect(db.joined).toBe(true)
  })

  it("survives a recording whose title is missing", async () => {
    db.rows = [{ run: RUN, videoTitle: null }]

    const { analyses } = (await (await list("?active=1")).json()) as {
      analyses: { video_title: string | null }[]
    }

    expect(analyses[0].video_title).toBeNull()
  })

  it("reports no work as an empty list rather than an error", async () => {
    const response = await list("?active=1")

    expect(response.status).toBe(200)
    expect((await response.json()).analyses).toEqual([])
  })

  it.each(["", "?active=0", "?active=all", "?status=running"])(
    "rejects %s instead of quietly listing every run ever",
    async (query) => {
      const response = await list(query)

      expect(response.status).toBe(400)
      expect(db.wheres).toHaveLength(0)
    }
  )
})
