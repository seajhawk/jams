import { sql } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GET as getMeasures } from "@/app/api/analyses/[id]/measures/route"
import { measures } from "@/db/schema"

type MeasureRow = typeof measures.$inferSelect

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status = 401
  }
  return {
    context: null as unknown,
    MockUnauthorizedError,
  }
})

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

  where() {
    return this
  }

  orderBy() {
    return this
  }

  limit() {
    return Promise.resolve(this.db.nextSelect())
  }
}

class MockDb {
  readonly selectRows: unknown[][] = []

  select() {
    return new SelectBuilder(this)
  }

  nextSelect() {
    return this.selectRows.shift() ?? []
  }
}

function makeMeasure(overrides: Partial<MeasureRow> = {}): MeasureRow {
  return {
    id: "meas-0001-uuid-0000-000000000001",
    runId: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
    orgId: "org_test",
    kind: "context_switch",
    category: "cognitive",
    tStartMs: 3000,
    tEndMs: null,
    valueNum: null,
    valueText: null,
    unit: null,
    confidence: 0.9,
    source: "video_analysis",
    providerId: "scene-detect",
    providerVersion: "1.0",
    payload: {},
    createdAt: new Date("2026-07-17T12:01:00.000Z"),
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

describe("GET /api/analyses/[id]/measures", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns measures for a valid org-scoped run", async () => {
    const db = new MockDb()
    db.selectRows.push(
      // First select: run existence check
      [{ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }],
      // Second select: measures query
      [
        makeMeasure({ kind: "context_switch", tStartMs: 1000 }),
        makeMeasure({ kind: "utterance", tStartMs: 2000, valueText: "Hello world", category: "speech" }),
      ]
    )
    installContext(db)

    const response = await getMeasures(
      new Request("http://jams.test/api/analyses/8c980f72-91f2-4778-bf2c-57c6f72f9b40/measures"),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )
    const body = (await response.json()) as { measures: { kind: string }[] }

    expect(response.status).toBe(200)
    expect(body.measures).toHaveLength(2)
    expect(body.measures[0].kind).toBe("context_switch")
    expect(body.measures[1].kind).toBe("utterance")
  })

  it("filters by kind query param", async () => {
    const db = new MockDb()
    db.selectRows.push(
      [{ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }],
      [makeMeasure({ kind: "context_switch" })]
    )
    installContext(db)

    const response = await getMeasures(
      new Request(
        "http://jams.test/api/analyses/8c980f72-91f2-4778-bf2c-57c6f72f9b40/measures?kind=context_switch"
      ),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )
    const body = (await response.json()) as { measures: { kind: string }[] }

    expect(response.status).toBe(200)
    expect(body.measures).toHaveLength(1)
    expect(body.measures[0].kind).toBe("context_switch")
  })

  it("returns 400 for an invalid kind param", async () => {
    const db = new MockDb()
    installContext(db)

    const response = await getMeasures(
      new Request(
        "http://jams.test/api/analyses/8c980f72-91f2-4778-bf2c-57c6f72f9b40/measures?kind=bogus_kind"
      ),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )

    expect(response.status).toBe(400)
  })

  it("returns 404 when the run is not found in the org", async () => {
    const db = new MockDb()
    db.selectRows.push([]) // run not found
    installContext(db)

    const response = await getMeasures(
      new Request("http://jams.test/api/analyses/8c980f72-91f2-4778-bf2c-57c6f72f9b40/measures"),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )

    expect(response.status).toBe(404)
  })

  it("returns 404 for a non-UUID id", async () => {
    const db = new MockDb()
    installContext(db)

    const response = await getMeasures(
      new Request("http://jams.test/api/analyses/not-a-uuid/measures"),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    )

    expect(response.status).toBe(404)
  })

  it("respects the limit query param", async () => {
    const db = new MockDb()
    db.selectRows.push(
      [{ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }],
      [makeMeasure({ kind: "context_switch" })]
    )
    installContext(db)

    const response = await getMeasures(
      new Request(
        "http://jams.test/api/analyses/8c980f72-91f2-4778-bf2c-57c6f72f9b40/measures?limit=1"
      ),
      { params: Promise.resolve({ id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40" }) }
    )

    expect(response.status).toBe(200)
    // Verify orgFilter was called (scoped to org)
    const context = mocks.context as {
      scopedDb: { orgFilter: ReturnType<typeof vi.fn> }
    }
    expect(context.scopedDb.orgFilter).toHaveBeenCalled()
  })
})
