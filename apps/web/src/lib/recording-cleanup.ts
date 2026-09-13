import { and, eq, isNull, lte, or, sql } from "drizzle-orm"

import { adminDb } from "@/db/admin-client.server"
import { recordingDeletions } from "@/db/schema"
import { cleanupRecordingBlobs } from "@/lib/blob"

const UPLOAD_SAS_LIFETIME_MS = 15 * 60 * 1000
const RETRY_MS = 5 * 60 * 1000
const VERIFY_AGAIN_MS = 24 * 60 * 60 * 1000

/** Retain and periodically sweep even verified jobs: remote writes can finish late. */
export async function reconcileRecordingCleanup(videoId?: string) {
  const now = new Date()
  const due = and(
    lte(recordingDeletions.nextSweepAt, now),
    or(isNull(recordingDeletions.leaseExpiresAt), lte(recordingDeletions.leaseExpiresAt, now)),
    videoId ? eq(recordingDeletions.videoId, videoId) : undefined,
  )
  const candidates = await adminDb.select({ videoId: recordingDeletions.videoId })
    .from(recordingDeletions).where(due).orderBy(recordingDeletions.nextSweepAt).limit(10)
  let sweptCount = 0
  let failedCount = 0
  for (const candidate of candidates) {
    // Keep a scheduled HTTP sweep bounded; remaining jobs keep their due date.
    if (Date.now() - now.getTime() >= 20_000) break
    const token = crypto.randomUUID()
    const [job] = await adminDb.update(recordingDeletions).set({
      leaseToken: token, leaseExpiresAt: new Date(Date.now() + RETRY_MS),
      attemptCount: sql`${recordingDeletions.attemptCount} + 1`,
    }).where(and(due, eq(recordingDeletions.videoId, candidate.videoId))).returning()
    if (!job) continue
    const owned = and(eq(recordingDeletions.videoId, job.videoId), eq(recordingDeletions.leaseToken, token))
    try {
      await cleanupRecordingBlobs({ orgId: job.orgId, videoId: job.videoId, runIds: job.runIds })
      const finished = new Date()
      const uploadExpiry = new Date(job.requestedAt.getTime() + UPLOAD_SAS_LIFETIME_MS)
      const verified = finished >= uploadExpiry
      await adminDb.update(recordingDeletions).set({
        leaseToken: null, leaseExpiresAt: null, lastError: null,
        lastVerifiedAt: verified ? finished : null,
        nextSweepAt: verified ? new Date(finished.getTime() + VERIFY_AGAIN_MS) : uploadExpiry,
      }).where(owned)
      sweptCount++
    } catch {
      // Do not retain provider error strings: they can contain credential-bearing URLs.
      await adminDb.update(recordingDeletions).set({
        leaseToken: null, leaseExpiresAt: null, lastError: "Storage cleanup needs retry",
        nextSweepAt: new Date(Date.now() + RETRY_MS), lastVerifiedAt: null,
      }).where(owned)
      failedCount++
    }
  }
  return { sweptCount, failedCount }
}
