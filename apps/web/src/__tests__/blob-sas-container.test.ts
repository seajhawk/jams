// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ createIfNotExists: vi.fn() }))

vi.mock("@azure/storage-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/storage-blob")>()
  return {
    ...actual,
    BlobServiceClient: {
      fromConnectionString: () => ({
        getContainerClient: () => ({
          createIfNotExists: mocks.createIfNotExists,
          getBlockBlobClient: (name: string) => ({
            url: `http://127.0.0.1:10000/devstoreaccount1/videos/${name}`,
          }),
        }),
      }),
    },
  }
})

import { mintReadSas, mintUploadSas, resetBlobContainerCacheForTests } from "@/lib/blob"

describe("SAS minting", () => {
  beforeEach(() => {
    vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true")
    resetBlobContainerCacheForTests()
    mocks.createIfNotExists.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("checks the container once per process, not on every signature", async () => {
    // Signing is local crypto. Each report view and upload used to PUT to Storage first,
    // inside the request's database transaction.
    await mintReadSas("org/video/original.mp4")
    await mintReadSas("org/video/original.mp4")
    await mintUploadSas("org/video/original.mp4", "video/mp4")

    expect(mocks.createIfNotExists).toHaveBeenCalledTimes(1)
  })

  it("still signs a working read URL", async () => {
    const { url, expiresAt } = await mintReadSas("org/video/original.mp4")

    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/devstoreaccount1/videos/org/video/original.mp4")
    expect(parsed.searchParams.get("sp")).toBe("r")
    expect(parsed.searchParams.get("sig")).toBeTruthy()
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it("does not remember a failed check, so a transient Storage error is not permanent", async () => {
    mocks.createIfNotExists
      .mockRejectedValueOnce(new Error("503 Server Busy"))
      .mockResolvedValue(undefined)

    await expect(mintReadSas("org/video/original.mp4")).rejects.toThrow("503")
    await expect(mintReadSas("org/video/original.mp4")).resolves.toHaveProperty("url")

    expect(mocks.createIfNotExists).toHaveBeenCalledTimes(2)
  })

  it("refuses a path that could escape the recording's prefix", async () => {
    await expect(mintReadSas("org/../other-org/video.mp4")).rejects.toThrow("Invalid blob path")
    expect(mocks.createIfNotExists).not.toHaveBeenCalled()
  })
})
