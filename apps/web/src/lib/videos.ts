import { z } from "zod"

export const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024

export const videoStatuses = ["uploading", "uploaded", "failed"] as const

export const videoContentTypes = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
] as const

export const videoStatusSchema = z.enum(videoStatuses)
export const videoContentTypeSchema = z.enum(videoContentTypes)

export type VideoStatus = (typeof videoStatuses)[number]
export type VideoContentType = (typeof videoContentTypes)[number]

export function extensionForContentType(contentType: VideoContentType) {
  switch (contentType) {
    case "video/mp4":
      return ".mp4"
    case "video/quicktime":
      return ".mov"
    case "video/webm":
      return ".webm"
    case "video/x-m4v":
      return ".m4v"
  }
}

export function originalBlobPath(input: {
  orgId: string
  videoId: string
  contentType: VideoContentType
}) {
  return `${input.orgId}/${input.videoId}/original${extensionForContentType(
    input.contentType
  )}`
}

export function posterBlobPath(input: { orgId: string; videoId: string }) {
  return `${input.orgId}/${input.videoId}/poster.jpg`
}

export const createVideoSchema = z.object({
  title: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(500),
  content_type: videoContentTypeSchema,
  size_bytes: z.number().int().positive().max(MAX_VIDEO_SIZE_BYTES),
  task_id: z.string().uuid().optional(),
  subject_label: z.string().trim().min(1).max(120).optional(),
  variant_label: z.string().trim().min(1).max(120).optional(),
})

const videoCompleteMetadataSchema = z.object({
  duration_ms: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  has_audio: z.boolean(),
  poster_uploaded: z.boolean(),
})

export const completeVideoSchema = z.union([
  z.object({ failed: z.literal(true) }),
  videoCompleteMetadataSchema.extend({ failed: z.literal(false).optional() }),
])

export const createTaskSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2_000).optional(),
})
