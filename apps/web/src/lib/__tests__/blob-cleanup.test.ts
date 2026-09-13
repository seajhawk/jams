// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  containers: new Map<string, {
    listBlobsFlat: ReturnType<typeof vi.fn>
    getBlobClient: ReturnType<typeof vi.fn>
  }>(),
  fromConnectionString: vi.fn(),
}))

vi.mock("@azure/storage-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/storage-blob")>()
  return {
    ...actual,
    BlobServiceClient: { fromConnectionString: mocks.fromConnectionString },
  }
})

import { cleanupRecordingBlobs } from "@/lib/blob"

const videoId = "11111111-1111-4111-8111-111111111111"
const runA = "22222222-2222-4222-8222-222222222222"
const runB = "33333333-3333-4333-8333-333333333333"

function asyncItems(items: Array<{ name: string; snapshot?: string; versionId?: string; isCurrentVersion?: boolean }>) {
  return (async function* () {
    yield* items
  })()
}

function setup() {
  mocks.containers.clear()
  for (const name of ["videos", "derived"]) {
    const blobs = new Map<string, {
      deleteIfExists: ReturnType<typeof vi.fn>
      withSnapshot: ReturnType<typeof vi.fn>
      withVersion: ReturnType<typeof vi.fn>
    }>()
    const container = {
      listBlobsFlat: vi.fn(() => asyncItems([])),
      getBlobClient: vi.fn((blobName: string) => {
        const existing = blobs.get(blobName)
        if (existing) return existing
        const deleteIfExists = vi.fn().mockResolvedValue({ succeeded: true })
        const blob = {
          deleteIfExists,
          withSnapshot: vi.fn(() => blob),
          withVersion: vi.fn(() => blob),
        }
        blobs.set(blobName, blob)
        return blob
      }),
    }
    mocks.containers.set(name, container)
  }
  mocks.fromConnectionString.mockReturnValue({
    getContainerClient: (name: string) => mocks.containers.get(name),
  })
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true")
  return {
    videos: mocks.containers.get("videos")!,
    derived: mocks.containers.get("derived")!,
  }
}

describe("recording blob cleanup", () => {
  beforeEach(() => setup())
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetAllMocks()
  })

  it("enumerates exact video, run, and legacy prefixes including snapshots and versions", async () => {
    const { videos, derived } = setup()
    videos.listBlobsFlat.mockReturnValue(asyncItems([
      { name: `org_acme/${videoId}/original.mp4`, snapshot: "snap" },
      { name: `org_acme/${videoId}/finalized/a.mp4`, versionId: "v1" },
    ]))
    derived.listBlobsFlat.mockImplementation(({ prefix }) => asyncItems([
      { name: `${prefix}artifact.json` },
    ]))

    await cleanupRecordingBlobs({ orgId: "org_acme", videoId, runIds: [runA, runB] })

    expect(videos.listBlobsFlat).toHaveBeenCalledWith(expect.objectContaining({
      prefix: `org_acme/${videoId}/`, includeSnapshots: true, includeVersions: true,
    }))
    expect(derived.listBlobsFlat.mock.calls.map(([options]) => options.prefix)).toEqual([
      `runs/${runA}/`, `runs/${runB}/`, `org_acme/${videoId}/`,
    ])
    for (const blob of videos.getBlobClient.mock.results) {
      expect(blob.value.deleteIfExists.mock.calls[0][0]).not.toHaveProperty("deleteSnapshots")
    }
    for (const blob of derived.getBlobClient.mock.results) {
      expect(blob.value.deleteIfExists).toHaveBeenCalledWith(expect.objectContaining({
        deleteSnapshots: "include",
      }))
    }
  })

  it.each([
    ["org/acme", videoId, []],
    ["org_acme/", videoId, []],
    ["org_acme", "not-a-uuid", []],
    ["org_acme", videoId, ["../bad"]],
  ])("rejects invalid scope before contacting storage", async (orgId, badVideoId, runIds) => {
    await expect(cleanupRecordingBlobs({ orgId, videoId: badVideoId, runIds })).rejects.toThrow(
      "Invalid recording cleanup scope"
    )
    expect(mocks.fromConnectionString).not.toHaveBeenCalled()
  })

  it("treats missing containers and blobs as benign", async () => {
    const { videos, derived } = setup()
    videos.listBlobsFlat.mockImplementation(() => { throw { statusCode: 404 } })
    derived.listBlobsFlat.mockImplementation(({ prefix }) => asyncItems([{ name: `${prefix}x` }]))
    derived.getBlobClient.mockReturnValue({
      deleteIfExists: vi.fn().mockRejectedValue({ statusCode: 404 }),
    })

    await expect(cleanupRecordingBlobs({ orgId: "org_acme", videoId, runIds: [runA] })).resolves.toBeUndefined()
  })

  it("rejects objects outside the exact prefix", async () => {
    const { videos } = setup()
    videos.listBlobsFlat.mockReturnValue(asyncItems([{ name: `another_org/${videoId}/original.mp4` }]))
    await expect(cleanupRecordingBlobs({ orgId: "org_acme", videoId, runIds: [] }))
      .rejects.toThrow("escaped cleanup prefix")
    expect(videos.getBlobClient).not.toHaveBeenCalled()
  })

  it("deletes the base before deleting its current version when no bare item is listed", async () => {
    const { videos } = setup()
    videos.listBlobsFlat.mockReturnValue(asyncItems([{
      name: `org_acme/${videoId}/original.mp4`, versionId: "current", isCurrentVersion: true,
    }]))
    const calls: string[] = []
    const historical = { deleteIfExists: vi.fn(async (options) => {
      expect(options).not.toHaveProperty("deleteSnapshots")
      calls.push("version")
    }) }
    videos.getBlobClient.mockReturnValue({
      deleteIfExists: vi.fn(async () => { calls.push("base") }),
      withVersion: vi.fn(() => historical),
    })
    await cleanupRecordingBlobs({ orgId: "org_acme", videoId, runIds: [] })
    expect(calls).toEqual(["base", "version"])
  })

  it("propagates non-404 storage failures", async () => {
    const { videos } = setup()
    videos.listBlobsFlat.mockImplementation(() => { throw { statusCode: 503 } })

    await expect(cleanupRecordingBlobs({ orgId: "org_acme", videoId, runIds: [] })).rejects.toMatchObject({
      statusCode: 503,
    })
  })
})
