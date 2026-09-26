import { MAX_VIDEO_SIZE_BYTES, videoContentTypes } from "@/lib/videos"

/**
 * Browser-side recording checks, run before any upload starts so a user learns about a limit in a
 * second instead of after transferring gigabytes. The server enforces the same limits again (the
 * browser is not trusted); these only have to agree with it, which is why the values come from
 * GET /api/limits and the defaults below mirror the server defaults in `@/lib/limits`.
 */

export type UploadLimits = {
  maxBytes: number
  maxDurationMs: number
  contentTypes: readonly string[]
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: MAX_VIDEO_SIZE_BYTES,
  maxDurationMs: 20 * 60 * 1000,
  contentTypes: videoContentTypes,
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/** Parses the GET /api/limits response; null if it is not the expected shape. */
export function uploadLimitsFromApi(body: unknown): UploadLimits | null {
  const upload = (body as { upload?: Record<string, unknown> } | null)?.upload
  if (!upload) return null
  const { max_bytes, max_duration_ms, content_types } = upload
  if (!positive(max_bytes) || !positive(max_duration_ms)) return null
  if (!Array.isArray(content_types) || !content_types.every((t) => typeof t === "string")) return null
  return { maxBytes: max_bytes, maxDurationMs: max_duration_ms, contentTypes: content_types }
}

export function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024)
  if (gib >= 1) return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}-minute`
}

function formatClock(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** File-level checks that need no decoding: container type and size. */
export function validateRecordingFile(
  file: { type: string; size: number },
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS
): string | null {
  if (!limits.contentTypes.includes(file.type)) {
    return "Unsupported file type. Please use MP4, MOV, WebM, or M4V."
  }
  if (file.size <= 0) {
    return "This file is empty. Please choose a different recording."
  }
  if (file.size > limits.maxBytes) {
    return `This file is ${formatBytes(file.size)}, over the ${formatBytes(limits.maxBytes)} limit. Please compress or trim it first.`
  }
  return null
}

/** Checks on what the browser's metadata probe found: length and a decodable video track. */
export function validateRecordingMetadata(
  metadata: { durationMs: number; width: number; height: number },
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS
): string | null {
  if (!metadata.width || !metadata.height) {
    // A container the browser can open but whose video codec it cannot decode reports 0x0.
    return "This browser cannot decode the video in this file (unsupported codec). Re-export it as an H.264 MP4 and try again."
  }
  if (!Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0) {
    return "Could not determine how long this recording is. Re-export it as an MP4 and try again."
  }
  if (metadata.durationMs > limits.maxDurationMs) {
    return `This video is ${formatClock(metadata.durationMs)} long, over the ${formatMinutes(limits.maxDurationMs)} limit. Please trim it before uploading.`
  }
  return null
}
