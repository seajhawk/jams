import { sql } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GET as exportAnalysis } from "@/app/api/analyses/[id]/export/route"
import {
  GET as listShares,
  POST as createShare,
} from "@/app/api/analyses/[id]/share/route"
import { DELETE as revokeShare } from "@/app/api/share-links/[id]/route"
import { generateShareToken } from "@/lib/share-links"

const RUN_ID = "8c980f72-91f2-4778-bf2c-57c6f72f9b40"
const LINK_ID = "a997fd12-bd20-499f-8a70-7631c4ff9b9b"

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status = 401
  }

  return {
    context: null as unknown,
    assembleReportPayload: vi.fn(),
    MockUnauthorizedError,
  }
})

vi.mock("@/lib/report-assembly", () => ({
  assembleReportPayload: mocks.assembleReportPayload,
  ReportNotFoundError: class ReportNotFoundError extends Error {},
  ReportNotReadyError: class ReportNotReadyError extends Error {},
}))

vi.mock("@/lib/with-org", () => ({
  UnauthorizedError: mocks.MockUnauthorizedError,
  isUnauthorized: (error: unknown) => error instanceof mocks.MockUnauthorizedError,
  withOrg: vi.fn((handler: (context: unknown) => unknown) => handler(mocks.context)),
}))

type InsertValues = Record<string, unknown>
type UpdateValues = Record<string, unknown>

class SelectBuilder {
  constructor(private readonly db: MockDb) {}

  from() {
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
    return Promise.resolve(this.db.nextUpdate())
  }
}

class MockDb {
  readonly inserts: InsertValues[] = []
  readonly updates: UpdateValues[] = []
  readonly selectRows: unknown[][] = []
  readonly updateRows: unknown[][] = []

  onInsert: (input: InsertValues) => unknown = (input) => input

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

  nextUpdate() {
    return this.updateRows.shift() ?? []
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

function shareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    orgId: "org_test",
    runId: RUN_ID,
    token: "token-last4",
    expiresAt: new Date("2026-07-24T12:00:00.000Z"),
    createdBy: "user_test",
    createdAt: new Date("2026-07-17T12:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  }
}

function measureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "measure-1",
    runId: RUN_ID,
    orgId: "org_test",
    kind: "utterance",
    category: "speech",
    tStartMs: 100,
    tEndMs: 200,
    valueNum: null,
    valueText: "Hello, \"quoted\"\nline",
    unit: null,
    confidence: 0.9,
    source: "video_analysis",
    providerId: "provider",
    providerVersion: "1",
    payload: {},
    createdAt: new Date("2026-07-17T12:00:00.000Z"),
    ...overrides,
  }
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://jams.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

describe("share link route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("generates 32-byte base64url tokens", () => {
    const token = generateShareToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("creates a share link and shows the token only in the create response", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: RUN_ID }])
    db.onInsert = (input) => shareRow(input)
    installContext(db)

    const response = await createShare(
      jsonRequest(`/api/analyses/${RUN_ID}/share`, { expiry_days: 7 }),
      { params: Promise.resolve({ id: RUN_ID }) }
    )
    const body = (await response.json()) as {
      token: string
      url: string
      link: { last4: string; token?: string }
    }

    expect(response.status).toBe(201)
    expect(db.inserts[0]).toMatchObject({
      orgId: "org_test",
      runId: RUN_ID,
      createdBy: "user_test",
    })
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.url).toBe(`http://jams.test/share/${body.token}`)
    expect(body.link.last4).toBe(body.token.slice(-4))
    expect(body.link).not.toHaveProperty("token")
  })

  it("lists share links without returning tokens", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: RUN_ID }], [shareRow()])
    installContext(db)

    const response = await listShares(
      new Request(`http://jams.test/api/analyses/${RUN_ID}/share`),
      { params: Promise.resolve({ id: RUN_ID }) }
    )
    const body = (await response.json()) as { links: Array<{ last4: string; token?: string }> }

    expect(response.status).toBe(200)
    expect(body.links[0].last4).toBe("ast4")
    expect(body.links[0]).not.toHaveProperty("token")
  })

  it("revokes links through an org-scoped soft update", async () => {
    const db = new MockDb()
    db.updateRows.push([shareRow({ revokedAt: new Date("2026-07-17T13:00:00.000Z") })])
    installContext(db)

    const response = await revokeShare(
      new Request(`http://jams.test/api/share-links/${LINK_ID}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: LINK_ID }) }
    )
    const body = (await response.json()) as { link: { revoked_at: string | null } }

    expect(response.status).toBe(200)
    expect(db.updates[0].revokedAt).toBeInstanceOf(Date)
    expect(body.link.revoked_at).toBe("2026-07-17T13:00:00.000Z")
  })
})

describe("export route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("exports escaped CSV measures for an org-scoped run", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: RUN_ID }], [measureRow()])
    installContext(db)

    const response = await exportAnalysis(
      new Request(`http://jams.test/api/analyses/${RUN_ID}/export?format=csv`),
      { params: Promise.resolve({ id: RUN_ID }) }
    )
    const csv = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="jams-report-${RUN_ID}.csv"`
    )
    expect(csv).toContain('"Hello, ""quoted""\nline"')
  })

  it("returns the full report payload as JSON", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: RUN_ID }])
    installContext(db)
    mocks.assembleReportPayload.mockResolvedValue({ run: { id: RUN_ID } })

    const response = await exportAnalysis(
      new Request(`http://jams.test/api/analyses/${RUN_ID}/export?format=json`),
      { params: Promise.resolve({ id: RUN_ID }) }
    )
    const body = (await response.json()) as { run: { id: string } }

    expect(response.status).toBe(200)
    expect(body.run.id).toBe(RUN_ID)
    expect(mocks.assembleReportPayload).toHaveBeenCalledWith(
      RUN_ID,
      "org_test",
      expect.objectContaining({ orgId: "org_test", db })
    )
  })

  it("does not export runs outside the active org scope", async () => {
    const db = new MockDb()
    db.selectRows.push([])
    installContext(db)

    const response = await exportAnalysis(
      new Request(`http://jams.test/api/analyses/${RUN_ID}/export?format=csv`),
      { params: Promise.resolve({ id: RUN_ID }) }
    )

    expect(response.status).toBe(404)
    expect(db.selectRows).toHaveLength(0)
  })
})
