export interface VideoMetadata {
  durationMs: number
  width: number
  height: number
  hasAudio: boolean
  posterBlob: Blob
}

/**
 * Extract duration, dimensions, audio presence, and a JPEG poster from a
 * video File — entirely client-side, before any network call.
 *
 * Seeks to min(1s, 10% of duration) to avoid the black first frame.
 * Scales the poster down to a max width of 1920 px at 0.8 JPEG quality.
 */
export function extractVideoMetadata(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video")
    video.preload = "metadata"
    video.muted = true
    video.crossOrigin = "anonymous"

    const objectUrl = URL.createObjectURL(file)
    let settled = false
    let capturing = false

    let captured: {
      durationMs: number
      width: number
      height: number
      hasAudio: boolean
    } | null = null

    function cleanup() {
      if (settled) return
      settled = true
      video.removeEventListener("error", onError)
      video.removeEventListener("loadedmetadata", onLoadedMetadata)
      video.removeEventListener("seeked", onSeeked)
      URL.revokeObjectURL(objectUrl)
      video.pause()
      video.src = ""
      video.remove()
    }

    function onError() {
      if (settled) return
      cleanup()
      reject(new Error("Failed to load video for metadata extraction"))
    }

    function onLoadedMetadata() {
      if (settled || capturing) return
      const durationMs = Math.round(video.duration * 1000)
      const width = video.videoWidth
      const height = video.videoHeight

      const v = video as unknown as Record<string, unknown>
      const hasAudio =
        (Array.isArray(v["audioTracks"]) &&
          (v["audioTracks"] as unknown[]).length > 0) ||
        Boolean(v["mozHasAudio"]) ||
        Number(v["webkitAudioDecodedByteCount"]) > 0

      captured = { durationMs, width, height, hasAudio }

      // Seek toward first meaningful frame
      video.currentTime = Math.min(1, video.duration * 0.1)
    }

    function onSeeked() {
      if (settled || capturing || !captured) return
      capturing = true

      const { durationMs, width, height, hasAudio } = captured

      const maxW = 1920
      const scale = width > maxW ? maxW / width : 1
      const canvasWidth = Math.max(1, Math.round(width * scale))
      const canvasHeight = Math.max(1, Math.round(height * scale))

      const canvas = document.createElement("canvas")
      canvas.width = canvasWidth
      canvas.height = canvasHeight

      const ctx = canvas.getContext("2d")
      if (!ctx) {
        cleanup()
        reject(new Error("Canvas 2D context not available"))
        return
      }

      ctx.drawImage(video, 0, 0, canvasWidth, canvasHeight)

      canvas.toBlob(
        (blob) => {
          if (settled) return
          cleanup()
          if (!blob) {
            reject(new Error("Failed to capture poster frame"))
            return
          }
          resolve({ durationMs, width, height, hasAudio, posterBlob: blob })
        },
        "image/jpeg",
        0.8
      )
    }

    video.addEventListener("error", onError)
    video.addEventListener("loadedmetadata", onLoadedMetadata)
    video.addEventListener("seeked", onSeeked)
    video.src = objectUrl
  })
}
