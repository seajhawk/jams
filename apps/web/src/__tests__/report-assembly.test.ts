import { beforeEach, describe, expect, it, vi } from "vitest"

import { reportPayloadSchema } from "@/lib/report-contract"
import {
  DEFAULT_WEIGHT_PROFILE_NORMALIZATION,
  DEFAULT_WEIGHT_PROFILE_WEIGHTS,
} from "@/lib/weight-profiles"

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const ORG_ID = "org_report_test"
const RUN_ID = "a1b2c3d4-0000-4000-8000-000000000001"
const VIDEO_ID = "a1b2c3d4-0000-4000-8000-000000000002"
const PROFILE_ID = "a1b2c3d4-0000-4000-8000-000000000003"
const TASK_ID = "a1b2c3d4-0000-4000-8000-000000000004"
const SEG_ID = "a1b2c3d4-0000-4000-8000-000000000005"

// ---------------------------------------------------------------------------
// Mock infrastructure (hoisted so vi.mock factories can reference them)
// ---------------------------------------------------------------------------

const { insertQueue, selectQueue, updateQueue, mockDb } = vi.hoisted(() => {
  const insertQueue: unknown[][] = []
  const selectQueue: unknown[][] = []
  const updateQueue: unknown[][] = []

  /**
   * Builds a Drizzle-like query chain that is also Promise-thenable.
   * Dequeues the next row-batch from `selectQueue` at `.select()` call time,
   * so concurrent `Promise.all` args capture their intended rows in order.
   */
  function makeChain(): Record<string, unknown> & PromiseLike<unknown[]> {
    const rows = selectQueue.shift() ?? []
    const chain: Record<string, unknown> & PromiseLike<unknown[]> = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      then: <T, E>(
        onFulfilled?: ((value: unknown[]) => T | PromiseLike<T>) | null,
        onRejected?: ((reason: unknown) => E | PromiseLike<E>) | null
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    }
    return chain
  }

  const mockDb = {
    execute: () => Promise.resolve([]),
    select: () => makeChain(),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertQueue.shift() ?? [v]),
        }),
        returning: () => Promise.resolve([v]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(updateQueue.shift() ?? []),
        }),
      }),
    }),
    transaction: (handler: (tx: unknown) => unknown) => handler(mockDb),
  }

  return { insertQueue, selectQueue, updateQueue, mockDb }
})

vi.mock("@/db/client", () => ({ db: mockDb }))

vi.mock("@/lib/blob", () => ({
  mintReadSas: vi.fn().mockResolvedValue({
    url: "https://storage.test/video.mp4?sas",
    expiresAt: "2099-01-01T00:00:00Z",
  }),
}))

// ---------------------------------------------------------------------------
// Seed data factories
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    videoId: VIDEO_ID,
    config: {},
    pipelineVersion: "f4-test.1",
    providerVersions: {},
    providerResults: {},
    status: "succeeded",
    stage: "finalize",
    progressPct: 100,
    stageDetail: null,
    errorCode: null,
    attempt: 1,
    supersededBy: null,
    startedAt: new Date("2026-07-17T12:00:00Z"),
    completedAt: new Date("2026-07-17T12:10:00Z"),
    createdAt: new Date("2026-07-17T12:00:00Z"),
    updatedAt: new Date("2026-07-17T12:10:00Z"),
    deletedAt: null,
    ...overrides,
  }
}

function makeVideoRow() {
  return {
    video: {
      id: VIDEO_ID,
      orgId: ORG_ID,
      taskId: TASK_ID,
      title: "Test workflow recording",
      blobPath: `${ORG_ID}/${VIDEO_ID}/original.mp4`,
      posterBlobPath: null,
      sizeBytes: 1000,
      contentType: "video/mp4",
      durationMs: 120000,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      subjectLabel: null,
      variantLabel: null,
      status: "uploaded",
      uploadedBy: "user_test",
      createdAt: new Date("2026-07-17T11:00:00Z"),
    },
    taskName: "Test task",
    taskId: TASK_ID,
  }
}

function makeProfile() {
  return {
    id: PROFILE_ID,
    orgId: ORG_ID,
    name: "Default",
    weights: DEFAULT_WEIGHT_PROFILE_WEIGHTS,
    normalization: DEFAULT_WEIGHT_PROFILE_NORMALIZATION,
    isDefault: true,
    createdAt: new Date("2026-07-17T12:00:00Z"),
    updatedAt: new Date("2026-07-17T12:00:00Z"),
    deletedAt: null,
  }
}

function makeSegment() {
  return {
    id: SEG_ID,
    orgId: ORG_ID,
    runId: RUN_ID,
    parentSegmentId: null,
    name: "Initial setup",
    tStartMs: 0,
    tEndMs: 60000,
    source: "audio_cue",
    thumbnail: null,
    createdAt: new Date("2026-07-17T12:10:00Z"),
  }
}

function makeUtterance() {
  return {
    id: `u-${RUN_ID.slice(0, 8)}`,
    orgId: ORG_ID,
    runId: RUN_ID,
    kind: "utterance",
    category: "speech",
    tStartMs: 1000,
    tEndMs: 4000,
    valueNum: null,
    valueText: "Hello world test",
    unit: null,
    confidence: 0.95,
    source: "video_analysis",
    providerId: "faster_whisper",
    providerVersion: "1.0.0",
    payload: {
      words: [
        { w: "Hello", t0: 1000, t1: 1500 },
        { w: "world", t0: 1600, t1: 2100 },
        { w: "test", t0: 2200, t1: 2700 },
      ],
    },
    createdAt: new Date("2026-07-17T12:10:00Z"),
  }
}

// ---------------------------------------------------------------------------
// Import the function under test AFTER the mocks are registered
// ---------------------------------------------------------------------------

import {
  assembleReportPayload,
  getOrCreateDefaultProfile,
  ReportNotFoundError,
  ReportNotReadyError,
} from "@/lib/report-assembly"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assembleReportPayload", () => {
  beforeEach(() => {
    insertQueue.length = 0
    selectQueue.length = 0
    updateQueue.length = 0
  })

  it("assembles a valid ReportPayload from seeded DB rows and validates against the zod schema", async () => {
    // Queue in the exact order assembleReportPayload issues selects:
    // 1. analysisRuns (org-scoped, by runId)
    selectQueue.push([makeRun()])
    // 2. videos + tasks join
    selectQueue.push([makeVideoRow()])
    // 3. segments (inside Promise.all, first)
    selectQueue.push([makeSegment()])
    // 4. measures (inside Promise.all, second)
    selectQueue.push([makeUtterance()])
    // 5. weightProfiles default (inside getOrCreateDefaultProfile via Promise.all)
    selectQueue.push([makeProfile()])
    // 6. effortScores (no stored score — triggers on-the-fly compute)
    selectQueue.push([])

    const payload = await assembleReportPayload(RUN_ID, ORG_ID)

    // Primary assertion: validates against the zod schema
    const parsed = reportPayloadSchema.safeParse(payload)
    expect(parsed.success, parsed.error?.message).toBe(true)

    if (!parsed.success) return

    expect(parsed.data.contract_version).toBe(1)
    expect(parsed.data.run.id).toBe(RUN_ID)
    expect(parsed.data.run.status).toBe("succeeded")
    expect(parsed.data.run.warnings).toHaveLength(0)
    expect(parsed.data.video.id).toBe(VIDEO_ID)
    expect(parsed.data.video.playback_url).toContain("sas")
    expect(parsed.data.task?.id).toBe(TASK_ID)
    expect(parsed.data.segments).toHaveLength(1)
    expect(parsed.data.measures).toHaveLength(1)
    expect(parsed.data.measures[0].kind).toBe("utterance")
    expect(parsed.data.score.profile.id).toBe(PROFILE_ID)
  })

  it.each([null, "", undefined])("preserves an unlabeled visual transition (%s)", async (label) => {
    selectQueue.push([makeRun()])
    selectQueue.push([makeVideoRow()])
    selectQueue.push([])
    selectQueue.push([{
      ...makeUtterance(),
      kind: "context_switch",
      category: "cognitive",
      tStartMs: 4000,
      tEndMs: null,
      valueNum: 1,
      valueText: null,
      unit: "switch",
      payload: { from: label, to: label },
    }])
    selectQueue.push([makeProfile()])
    selectQueue.push([])

    const payload = reportPayloadSchema.parse(await assembleReportPayload(RUN_ID, ORG_ID))
    expect(payload.measures).toHaveLength(1)
    expect(payload.measures[0]).toMatchObject({
      kind: "context_switch", t_start_ms: 4000, payload: { from: null, to: null },
    })
    expect(payload.score.breakdown.find((row) => row.kind === "context_switch")?.raw).toBe(1)
  })

  it("adds a warning and uses partial status for partial runs", async () => {
    selectQueue.push([makeRun({ status: "partial", errorCode: "no_audio" })])
    selectQueue.push([makeVideoRow()])
    selectQueue.push([])   // segments
    selectQueue.push([])   // measures
    selectQueue.push([makeProfile()])
    selectQueue.push([])   // effortScores

    const payload = await assembleReportPayload(RUN_ID, ORG_ID)

    expect(payload.run.status).toBe("partial")
    expect(payload.run.warnings).toHaveLength(1)
    expect(payload.run.warnings[0].code).toBe("no_audio")
  })

  it("throws ReportNotReadyError for failed runs", async () => {
    selectQueue.push([makeRun({ status: "failed" })])

    await expect(assembleReportPayload(RUN_ID, ORG_ID)).rejects.toThrow(ReportNotReadyError)
  })

  it("throws ReportNotFoundError when the run does not belong to the org", async () => {
    selectQueue.push([])  // empty → run not found

    await expect(assembleReportPayload(RUN_ID, ORG_ID)).rejects.toThrow(ReportNotFoundError)
  })
})

describe("getOrCreateDefaultProfile", () => {
  beforeEach(() => {
    insertQueue.length = 0
    selectQueue.length = 0
    updateQueue.length = 0
  })

  it("reselects the default profile when creation loses a concurrent insert race", async () => {
    const profile = makeProfile()
    selectQueue.push([]) // no default on first read
    insertQueue.push([]) // insert skipped by on conflict do nothing
    selectQueue.push([profile]) // concurrent request created the default

    await expect(getOrCreateDefaultProfile(ORG_ID)).resolves.toEqual(profile)
  })

  it("promotes an existing non-default profile named Default when no default exists", async () => {
    const namedDefault = { ...makeProfile(), isDefault: false }
    const promotedDefault = { ...namedDefault, isDefault: true }
    selectQueue.push([]) // no default on first read
    insertQueue.push([]) // insert skipped by unique org/name conflict
    selectQueue.push([]) // still no default after insert conflict
    selectQueue.push([namedDefault])
    updateQueue.push([promotedDefault])

    await expect(getOrCreateDefaultProfile(ORG_ID)).resolves.toEqual(promotedDefault)
  })
})
