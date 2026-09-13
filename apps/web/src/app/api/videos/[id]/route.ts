import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { tasks, videos } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { serializeVideo } from "@/lib/video-response"
import { withOrg } from "@/lib/with-org"
import { requestRecordingDeletion } from "@/lib/recording-deletion"
import { reconcileRecordingCleanup } from "@/lib/recording-cleanup"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) return jsonError("Not found", 404)
    const deletion = await withOrg(({ scopedDb }) => requestRecordingDeletion(scopedDb, id))
    // Cleanup cannot run until revocation and its durable intent have committed.
    // Scheduler retries even if this request/process fails immediately afterward.
    await reconcileRecordingCleanup(deletion.videoId).catch(() => undefined)
    return NextResponse.json({ deletion: { video_id: id, status: "cleanup_pending" } }, { status: 202 })
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    if ([error, cause].some((e) => typeof e === "object" && e !== null && "code" in e &&
      (e.code === "55P03" || e.code === "40P01"))) {
      return jsonError("Recording is busy finishing work. Try deletion again.", 409)
    }
    return handleRouteError(error)
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    return await withOrg(async ({ orgId, scopedDb }) => {
      const [row] = await scopedDb.db
        .select({ video: videos, taskName: tasks.name })
        .from(videos)
        .leftJoin(
          tasks,
          and(eq(videos.taskId, tasks.id), eq(tasks.orgId, orgId))
        )
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
        .limit(1)

      if (!row) {
        return jsonError("Not found", 404)
      }

      return NextResponse.json({ video: serializeVideo(row.video, row.taskName) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
