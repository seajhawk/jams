import { sql } from "drizzle-orm"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GET as getAnalysis } from "@/app/api/analyses/[id]/route"
import { POST as createAnalysis } from "@/app/api/analyses/route"
import { analysisRuns } from "@/db/schema"

type AnalysisRunRow = typeof analysisRuns.$inferSelect
type InsertValues = Record<string, unknown>
type UpdateValues = Record<string, unknown>

const mocks = vi.hoisted(() => {
  class MockUnauthorizedError extends Error {
    readonly status = 401
  }

  return {
    context: null as unknown,
    dispatchAnalysisRun: vi.fn(),
    enqueueAnalysisRun: vi.fn(),
    MockUnauthorizedError,
  }
})

vi.mock("@/lib/queue", () => ({
  enqueueAnalysisRun: mocks.enqueueAnalysisRun,
}))

vi.mock("@/lib/analysis-dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-dispatch")>()
  return {
    ...actual,
    dispatchAnalysisRun: mocks.dispatchAnalysisRun,
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
    return Promise.resolve([])
  }
}

class MockDb {
  readonly inserts: InsertValues[] = []
  readonly updates: UpdateValues[] = []
  readonly selectRows: unknown[][] = []

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
}

function analysisRun(overrides: Partial<AnalysisRunRow> = {}): AnalysisRunRow {
  return {
    id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
    orgId: "org_test",
    videoId: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11",
    config: {},
    configSource: null,
    pipelineVersion: "f3-worker-spine.1",
    providerVersions: {},
    providerResults: {},
    status: "queued",
    stage: "queued",
    progressPct: 0,
    stageDetail: "Waiting for worker",
    errorCode: null,
    attempt: 0,
    supersededBy: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-07-17T12:00:00.000Z"),
    updatedAt: new Date("2026-07-17T12:00:00.000Z"),
    deletedAt: null,
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

describe("analyses API route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dispatchAnalysisRun.mockResolvedValue({ dispatched: true })
    mocks.enqueueAnalysisRun.mockResolvedValue(undefined)
  })

  it("creates a queued run for an uploaded org video and enqueues it", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11", status: "uploaded" }])
    db.onInsert = (input) =>
      "videoId" in input
        ? analysisRun({
            ...(input as Partial<AnalysisRunRow>),
            createdAt: new Date("2026-07-17T12:00:00.000Z"),
            updatedAt: new Date("2026-07-17T12:00:00.000Z"),
          })
        : {
            id: "outbox_test",
            ...input,
            createdAt: new Date("2026-07-17T12:00:00.000Z"),
            updatedAt: new Date("2026-07-17T12:00:00.000Z"),
          }
    installContext(db)

    const response = await createAnalysis(
      jsonRequest("/api/analyses", {
        video_id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11",
      })
    )
    const body = (await response.json()) as { analysis: { id: string; status: string } }

    expect(response.status).toBe(201)
    expect(body.analysis.status).toBe("queued")
    expect(db.inserts[0]).toMatchObject({
      orgId: "org_test",
      videoId: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11",
      status: "queued",
      stage: "queued",
    })
    expect(db.inserts[1]).toMatchObject({
      orgId: "org_test",
      runId: body.analysis.id,
      status: "pending",
    })
    expect(db.updates[0]).toMatchObject({ supersededBy: body.analysis.id })
    expect(mocks.dispatchAnalysisRun).toHaveBeenCalledWith({
      runId: body.analysis.id,
      outboxId: "outbox_test",
    })
  })

  it("stores canonical analysis config and source text when supplied", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11", status: "uploaded" }])
    db.onInsert = (input) =>
      "videoId" in input
        ? analysisRun({
            ...(input as Partial<AnalysisRunRow>),
            createdAt: new Date("2026-07-17T12:00:00.000Z"),
            updatedAt: new Date("2026-07-17T12:00:00.000Z"),
          })
        : {
            id: "outbox_test",
            ...input,
            createdAt: new Date("2026-07-17T12:00:00.000Z"),
            updatedAt: new Date("2026-07-17T12:00:00.000Z"),
          }
    installContext(db)

    const configSource = "sentiment:\n  fallback: vader\n"
    const response = await createAnalysis(
      jsonRequest("/api/analyses", {
        video_id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11",
        config: {
          sentiment: { fallback: "vader" },
          llm_labeling: { enabled: true },
        },
        config_source: configSource,
      })
    )
    const body = (await response.json()) as {
      analysis: { config: { sentiment: { fallback: string } }; config_source: string }
    }

    expect(response.status).toBe(201)
    expect(db.inserts[0]).toMatchObject({
      config: expect.objectContaining({
        probe: { enabled: true },
        context_switch: { enabled: true, detector_impl: "adaptive" },
        transcription: { enabled: true },
        sentiment: { enabled: true, fallback: "vader" },
        llm_labeling: { enabled: true },
      }),
      configSource,
    })
    expect(db.inserts[1]).toMatchObject({
      orgId: "org_test",
      status: "pending",
    })
    expect(body.analysis.config.sentiment.fallback).toBe("vader")
    expect(body.analysis.config_source).toBe(configSource)
    expect(mocks.dispatchAnalysisRun).toHaveBeenCalled()
  })

  it("rejects invalid analysis config with a path-aware error", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11", status: "uploaded" }])
    installContext(db)

    const response = await createAnalysis(
      jsonRequest("/api/analyses", {
        video_id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11",
        config: { context_switch: { enabled: false } },
        config_source: "context_switch:\n  enabled: false\n",
      })
    )
    const body = (await response.json()) as { error: string }

    expect(response.status).toBe(400)
    expect(body.error).toContain("context_switch.enabled")
    expect(db.inserts).toHaveLength(0)
    expect(mocks.dispatchAnalysisRun).not.toHaveBeenCalled()
  })

  it("rejects analysis before upload completion", async () => {
    const db = new MockDb()
    db.selectRows.push([{ id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11", status: "uploading" }])
    installContext(db)

    const response = await createAnalysis(
      jsonRequest("/api/analyses", {
        video_id: "e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11",
      })
    )

    expect(response.status).toBe(400)
    expect(db.inserts).toHaveLength(0)
    expect(mocks.dispatchAnalysisRun).not.toHaveBeenCalled()
  })

  it("returns the polling payload for an org-scoped run", async () => {
    const db = new MockDb()
    db.selectRows.push([
      analysisRun({
        status: "running",
        stage: "probe",
        progressPct: 35,
        stageDetail: "Normalizing... 35%",
        startedAt: new Date("2026-07-17T12:01:00.000Z"),
      }),
    ])
    installContext(db)

    const response = await getAnalysis(
      new Request("http://jams.test/api/analyses/8c980f72-91f2-4778-bf2c-57c6f72f9b40"),
      {
        params: Promise.resolve({
          id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
        }),
      }
    )
    const body = (await response.json()) as {
      analysis: { status: string; progress_pct: number; timestamps: { started_at: string } }
    }

    expect(response.status).toBe(200)
    expect(body.analysis).toMatchObject({
      status: "running",
      progress_pct: 35,
    })
    expect(body.analysis.timestamps.started_at).toBe("2026-07-17T12:01:00.000Z")
  })
})
