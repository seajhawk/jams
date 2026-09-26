import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm"

import { adminDb } from "@/db/admin-client.server"
import { videos } from "@/db/schema"
import { deleteVideoBlob } from "@/lib/blob"
import { resolveLimitPolicy } from "@/lib/limits"

/**
 * Watchdog sweep for abandoned and leftover uploads (docs/design/abuse-and-scale-hardening.md §7).
 *
 * 1. A recording still `uploading` long after its 15-minute write SAS expired will never
 *    complete; mark it failed so it stops looking in progress.
 * 2. Once the write SAS has expired nobody can write to the client upload paths again, so delete
 *    them: for a finalized recording they are a duplicate of the server-owned finalized copy
 *    (which is what playback and analysis read), for a failed one they are all that is left.
 *    `upload_sources_cleaned_at` records success; a failed upload then stops counting against the
 *    organization's storage cap.
 *
 * Runs with the admin connection (cross-tenant, like the recording-deletion sweep) and is bounded
 * per call so a scheduled HTTP request stays short. Never deletes a finalized path.
 */

const UPLOAD_SAS_LIFETIME_MS = 15 * 60 * 1000
const SOURCE_CLEANUP_MARGIN_MS = 5 * 60 * 1000
const DEFAULT_BATCH = 25
const TIME_BUDGET_MS = 20_000

export type UploadCleanupResult = {
  markedFailedCount: number
  cleanedCount: number
  failedCount: number
}

type Candidate = {
  id: string
  orgId: string
  status: string
  blobPath: string
  posterBlobPath: string | null
}

/** The client-writable paths created with the recording's write SAS, never a finalized copy. */
export function uploadSourcePaths(video: Candidate): string[] {
  const prefix = `${video.orgId}/${video.id}/`
  const originalName = video.blobPath.split("/").pop()
  const paths = new Set<string>()
  if (originalName) paths.add(`${prefix}${originalName}`)
  paths.add(`${prefix}poster.jpg`)
  return [...paths].filter(
    (path) =>
      path.startsWith(prefix) &&
      !path.slice(prefix.length).includes("/") &&
      // Belt and braces: a finalized recording's current paths are never touched.
      (video.status !== "uploaded" || (path !== video.blobPath && path !== video.posterBlobPath))
  )
}

export async function sweepStaleUploads(
  options: {
    now?: Date
    staleUploadMinutes?: number
    batchSize?: number
    deleteBlob?: (path: string) => Promise<unknown>
  } = {}
): Promise<UploadCleanupResult> {
  const now = options.now ?? new Date()
  const staleMinutes = options.staleUploadMinutes ?? resolveLimitPolicy().cleanup.staleUploadMinutes
  const deleteBlob = options.deleteBlob ?? deleteVideoBlob
  const startedAt = Date.now()

  const staleBefore = new Date(now.getTime() - staleMinutes * 60 * 1000)
  const marked = await adminDb
    .update(videos)
    .set({ status: "failed" })
    .where(and(eq(videos.status, "uploading"), lt(videos.createdAt, staleBefore)))
    .returning({ id: videos.id })

  const sasExpiredBefore = new Date(now.getTime() - UPLOAD_SAS_LIFETIME_MS - SOURCE_CLEANUP_MARGIN_MS)
  const candidates: Candidate[] = await adminDb
    .select({
      id: videos.id,
      orgId: videos.orgId,
      status: videos.status,
      blobPath: videos.blobPath,
      posterBlobPath: videos.posterBlobPath,
    })
    .from(videos)
    .where(
      and(
        inArray(videos.status, ["uploaded", "failed"]),
        isNull(videos.uploadSourcesCleanedAt),
        lt(videos.createdAt, sasExpiredBefore)
      )
    )
    .orderBy(asc(videos.createdAt))
    .limit(options.batchSize ?? DEFAULT_BATCH)

  let cleanedCount = 0
  let failedCount = 0
  for (const video of candidates) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) break
    try {
      for (const path of uploadSourcePaths(video)) {
        await deleteBlob(path)
      }
      await adminDb
        .update(videos)
        .set({
          uploadSourcesCleanedAt: sql`now()`,
          // A failed recording's poster pointed at the upload path just deleted.
          ...(video.status === "failed" ? { posterBlobPath: null } : {}),
        })
        .where(and(eq(videos.id, video.id), isNull(videos.uploadSourcesCleanedAt)))
      cleanedCount++
    } catch {
      // Retried on the next sweep. Provider errors can carry credential-bearing URLs; not logged.
      failedCount++
    }
  }

  return { markedFailedCount: marked.length, cleanedCount, failedCount }
}
