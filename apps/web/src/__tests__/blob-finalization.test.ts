// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ properties: vi.fn(), copy: vi.fn(), poll: vi.fn() }))
vi.mock("@azure/storage-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/storage-blob")>()
  return { ...actual, BlobServiceClient: {
    fromConnectionString: () => ({ getContainerClient: () => ({
      createIfNotExists: async () => undefined,
      getBlockBlobClient: (name: string) => ({ url: `http://127.0.0.1:10000/devstoreaccount1/videos/${name}`,
        getProperties: mocks.properties, beginCopyFromURL: mocks.copy }),
    }) }),
  } }
})
import { finalizeBlob } from "@/lib/blob"

describe("finalized blob copy", () => {
  beforeEach(() => {
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true")
    mocks.properties.mockResolvedValue({ etag: '"v1"', contentLength: 10 })
    mocks.copy.mockImplementation(async () => ({ pollUntilDone: mocks.poll }))
    mocks.poll.mockResolvedValue({ copyStatus: "success" })
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks() })
  it("pins source bytes and creates a distinct destination", async () => {
    const result = await finalizeBlob("org/video/original.mp4", 10)
    expect(result.blobPath).toMatch(/^org\/video\/finalized\/[0-9a-f-]{36}\/original.mp4$/)
    expect(mocks.copy).toHaveBeenCalledWith(expect.any(String), {
      sourceConditions: { ifMatch: '"v1"' }, conditions: { ifNoneMatch: "*" },
    })
    expect(mocks.poll).toHaveBeenCalledOnce()
  })
  it("does not accept a changed source", async () => {
    mocks.copy.mockRejectedValue({ statusCode: 412 })
    await expect(finalizeBlob("org/video/original.mp4", 10)).rejects.toMatchObject({ status: 409 })
  })
  it.each(["pending", "failed", "aborted"])("does not accept copy status %s", async (copyStatus) => {
    mocks.poll.mockResolvedValue({ copyStatus })
    await expect(finalizeBlob("org/video/original.mp4", 10)).rejects.toMatchObject({ status: 409 })
  })
  it("rejects size mismatch before copying", async () => {
    await expect(finalizeBlob("org/video/original.mp4", 11)).rejects.toMatchObject({ status: 400 })
    expect(mocks.copy).not.toHaveBeenCalled()
  })
  it("rejects sources without an ETag", async () => {
    mocks.properties.mockResolvedValue({ contentLength: 10 })
    await expect(finalizeBlob("org/video/original.mp4", 10)).rejects.toMatchObject({ status: 409 })
    expect(mocks.copy).not.toHaveBeenCalled()
  })
})
