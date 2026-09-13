import { eq, sql } from "drizzle-orm"

import { analysisRuns, recordingDeletions, videos } from "@/db/schema"
import { HttpError } from "@/lib/api"
import { lockPreviewUsage } from "@/lib/preview-limits"
import { MAX_VIDEO_SIZE_BYTES } from "@/lib/videos"
import type { OrgContext } from "@/lib/with-org"

/** Caller must commit this intent and relational cascade together via withOrg. */
export async function requestRecordingDeletion(scopedDb: OrgContext["scopedDb"], videoId: string) {
  // Avoid holding an HTTP request indefinitely behind an admitted worker upload.
  await scopedDb.db.execute(sql`set local lock_timeout = '5s'`)
  const [video] = await scopedDb.db.select().from(videos)
    .where(scopedDb.orgFilter(videos, eq(videos.id, videoId))).for("update").limit(1)
  if (!video) {
    const [existing] = await scopedDb.db.select().from(recordingDeletions)
      .where(scopedDb.orgFilter(recordingDeletions, eq(recordingDeletions.videoId, videoId))).limit(1)
    if (existing) return existing
    throw new HttpError(404, "Recording not found")
  }

  // Serialize the transfer from live rows to retained usage, even when preview
  // admission is disabled, so enabling it later preserves consumed allowance.
  await lockPreviewUsage(scopedDb)
  const runs = await scopedDb.db.select({ id: analysisRuns.id }).from(analysisRuns)
    .where(scopedDb.orgFilter(analysisRuns, eq(analysisRuns.videoId, videoId)))
  const [deletion] = await scopedDb.db.insert(recordingDeletions).values({
    videoId, orgId: scopedDb.orgId, runIds: runs.map((run) => run.id),
    analysisCount: runs.length, reservedBytes: video.sizeBytes ?? MAX_VIDEO_SIZE_BYTES,
  }).returning()
  // Run cascades revoke shares, reports, dispatch intents and measures. In-flight
  // uploads hold KEY SHARE on their run, so this waits before cleanup is eligible.
  await scopedDb.db.delete(videos).where(scopedDb.orgFilter(videos, eq(videos.id, videoId)))
  return deletion
}
