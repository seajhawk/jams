import { describe, expect, it } from "vitest"

import { isSafeBlobPath } from "@/lib/blob"
import {
  MAX_VIDEO_SIZE_BYTES,
  createVideoSchema,
  originalBlobPath,
  posterBlobPath,
} from "@/lib/videos"

describe("video upload helpers", () => {
  it("builds tenant-prefixed blob paths without repeating the container name", () => {
    expect(
      originalBlobPath({
        orgId: "org_123",
        videoId: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
        contentType: "video/mp4",
      })
    ).toBe("org_123/8c980f72-91f2-4778-bf2c-57c6f72f9b40/original.mp4")

    expect(
      posterBlobPath({
        orgId: "org_123",
        videoId: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
      })
    ).toBe("org_123/8c980f72-91f2-4778-bf2c-57c6f72f9b40/poster.jpg")
  })

  it("accepts only supported video content types and the 2 GiB size limit", () => {
    const base = {
      title: "Checkout flow",
      filename: "checkout.mp4",
      content_type: "video/mp4",
      size_bytes: MAX_VIDEO_SIZE_BYTES,
    }

    expect(createVideoSchema.safeParse(base).success).toBe(true)
    expect(
      createVideoSchema.safeParse({
        ...base,
        content_type: "application/octet-stream",
      }).success
    ).toBe(false)
    expect(
      createVideoSchema.safeParse({
        ...base,
        size_bytes: MAX_VIDEO_SIZE_BYTES + 1,
      }).success
    ).toBe(false)
  })

  it("rejects unsafe blob paths before minting SAS URLs", () => {
    expect(isSafeBlobPath("org/video/original.mp4")).toBe(true)
    expect(isSafeBlobPath("/org/video/original.mp4")).toBe(false)
    expect(isSafeBlobPath("org/../video/original.mp4")).toBe(false)
    expect(isSafeBlobPath("org\\video\\original.mp4")).toBe(false)
  })
})
