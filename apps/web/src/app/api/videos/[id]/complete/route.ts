import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { videos } from "@/db/schema"
import { handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import { blobStats } from "@/lib/blob"
import { serializeVideo } from "@/lib/video-response"
import { completeVideoSchema } from "@/lib/videos"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    const body = await parseJsonBody(request, completeVideoSchema)

    return await withOrg(async ({ scopedDb }) => {
      const [video] = await scopedDb.db
        .select()
        .from(videos)
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
        .limit(1)

      if (!video) {
        return jsonError("Not found", 404)
      }

      if ("failed" in body && body.failed) {
        const [updated] = await scopedDb.db
          .update(videos)
          .set({ status: "failed" })
          .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
          .returning()

        return NextResponse.json({ video: serializeVideo(updated) })
      }

      const stats = await blobStats(video.blobPath)
      if (!stats.exists) {
        return jsonError("Uploaded blob was not found", 409)
      }

      if (stats.sizeBytes !== video.sizeBytes) {
        return jsonError("Uploaded blob size does not match requested size", 400)
      }

      const [updated] = await scopedDb.db
        .update(videos)
        .set({
          durationMs: body.duration_ms,
          width: body.width,
          height: body.height,
          hasAudio: body.has_audio,
          posterBlobPath: body.poster_uploaded ? video.posterBlobPath : null,
          status: "uploaded",
        })
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
        .returning()

      return NextResponse.json({ video: serializeVideo(updated) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
