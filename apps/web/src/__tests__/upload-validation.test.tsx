import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_UPLOAD_LIMITS,
  uploadLimitsFromApi,
  validateRecordingFile,
  validateRecordingMetadata,
} from "@/lib/upload-validation"

const mocks = vi.hoisted(() => ({ extractVideoMetadata: vi.fn() }))
vi.mock("@/components/upload/useVideoMetadata", () => ({
  extractVideoMetadata: mocks.extractVideoMetadata,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { UploadDialog } from "@/components/upload/UploadDialog"

const GIB = 1024 * 1024 * 1024

describe("recording checks before upload", () => {
  it("accepts a normal recording", () => {
    expect(validateRecordingFile({ type: "video/mp4", size: 30 * 1024 * 1024 })).toBeNull()
    expect(validateRecordingMetadata({ durationMs: 6 * 60_000, width: 3840, height: 2160 })).toBeNull()
  })

  it("rejects the wrong container, empty files and oversize files with a readable reason", () => {
    expect(validateRecordingFile({ type: "video/x-matroska", size: 10 })).toMatch(/Unsupported file type/)
    expect(validateRecordingFile({ type: "video/mp4", size: 0 })).toMatch(/empty/)
    expect(validateRecordingFile({ type: "video/mp4", size: 3 * GIB })).toBe(
      "This file is 3 GiB, over the 2 GiB limit. Please compress or trim it first."
    )
  })

  it("rejects over-long, unmeasurable and undecodable recordings", () => {
    expect(validateRecordingMetadata({ durationMs: 21 * 60_000 + 5_000, width: 1920, height: 1080 })).toBe(
      "This video is 21:05 long, over the 20-minute limit. Please trim it before uploading."
    )
    expect(validateRecordingMetadata({ durationMs: Infinity, width: 1920, height: 1080 })).toMatch(
      /Could not determine how long/
    )
    expect(validateRecordingMetadata({ durationMs: 60_000, width: 0, height: 0 })).toMatch(/unsupported codec/)
  })

  it("uses the server's limits when it sends them, and ignores a malformed response", () => {
    const limits = uploadLimitsFromApi({
      upload: { max_bytes: 100 * 1024 * 1024, max_duration_ms: 300_000, content_types: ["video/mp4"] },
    })
    expect(limits).toEqual({ maxBytes: 100 * 1024 * 1024, maxDurationMs: 300_000, contentTypes: ["video/mp4"] })
    expect(validateRecordingFile({ type: "video/webm", size: 1 }, limits!)).toMatch(/Unsupported/)
    expect(validateRecordingFile({ type: "video/mp4", size: 200 * 1024 * 1024 }, limits!)).toMatch(/100 MB limit/)
    expect(validateRecordingMetadata({ durationMs: 301_000, width: 1, height: 1 }, limits!)).toMatch(/5-minute/)
    expect(uploadLimitsFromApi({ upload: { max_bytes: "big" } })).toBeNull()
    expect(uploadLimitsFromApi(null)).toBeNull()
    expect(DEFAULT_UPLOAD_LIMITS.maxBytes).toBe(2 * GIB)
  })
})

describe("UploadDialog", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/limits") {
        return new Response(JSON.stringify({
          upload: { max_bytes: 1000, max_duration_ms: 60_000, content_types: ["video/mp4"] },
        }))
      }
      return new Response(JSON.stringify({ tasks: [] }))
    })
    vi.stubGlobal("fetch", fetchMock)
    mocks.extractVideoMetadata.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  async function openAndChoose(file: File) {
    render(<UploadDialog />)
    fireEvent.click(screen.getByRole("button", { name: /upload journey/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/limits"))
    // Let the limits response land before choosing a file.
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.change(screen.getByTestId("upload-file-input"), { target: { files: [file] } })
  }

  it("rejects a file over the server's size limit before probing or uploading it", async () => {
    await openAndChoose(new File([new Uint8Array(2000)], "big.mp4", { type: "video/mp4" }))
    expect(await screen.findByText(/This file is 2 KB, over the 1 KB limit/)).toBeTruthy()
    expect(mocks.extractVideoMetadata).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalledWith("/api/videos", expect.anything())
  })

  it("rejects a recording whose probe shows it is too long", async () => {
    mocks.extractVideoMetadata.mockResolvedValue({
      durationMs: 61_000, width: 1280, height: 720, hasAudio: true, posterBlob: new Blob(),
    })
    await openAndChoose(new File([new Uint8Array(10)], "long.mp4", { type: "video/mp4" }))
    expect(await screen.findByText(/over the 1-minute limit/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalledWith("/api/videos", expect.anything())
  })
})
