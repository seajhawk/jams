import { videos } from "@/db/schema"

type VideoRow = typeof videos.$inferSelect

export function serializeVideo(video: VideoRow, taskName: string | null = null) {
  return {
    id: video.id,
    task_id: video.taskId,
    task_name: taskName,
    title: video.title,
    blob_path: video.blobPath,
    poster_blob_path: video.posterBlobPath,
    size_bytes: video.sizeBytes,
    content_type: video.contentType,
    duration_ms: video.durationMs,
    width: video.width,
    height: video.height,
    fps: video.fps,
    has_audio: video.hasAudio,
    subject_label: video.subjectLabel,
    variant_label: video.variantLabel,
    status: video.status,
    uploaded_by: video.uploadedBy,
    created_at: video.createdAt.toISOString(),
  }
}
