import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { videos } from "@/db/schema"
import { handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import { BlobFinalizationError, finalizeBlob } from "@/lib/blob"
import { limitPolicyForOrg } from "@/lib/limits"
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

    return await withOrg(async ({ orgId, scopedDb }) => {
      const [video] = await scopedDb.db
        .select()
        .from(videos)
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
        .for("update")
        .limit(1)

      if (!video) {
        return jsonError("Not found", 404)
      }

      if ("failed" in body && body.failed) {
        if (video.status === "uploaded") return jsonError("Finalized video cannot be changed", 409)
        if (video.status === "failed") return NextResponse.json({ video: serializeVideo(video) })
        const [updated] = await scopedDb.db
          .update(videos)
          .set({ status: "failed" })
          .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
          .returning()

        return NextResponse.json({ video: serializeVideo(updated) })
      }

      if (video.status === "uploaded") {
        if (video.durationMs !== body.duration_ms || video.width !== body.width ||
            video.height !== body.height || video.hasAudio !== body.has_audio ||
            Boolean(video.posterBlobPath) !== body.poster_uploaded) {
          return jsonError("Finalized video cannot be changed", 409)
        }
        return NextResponse.json({ video: serializeVideo(video) })
      }
      if (video.status !== "uploading" || video.sizeBytes === null) {
        return jsonError("Video is not awaiting upload completion", 409)
      }

      const policy = limitPolicyForOrg(orgId)
      const markFailed = () =>
        scopedDb.db
          .update(videos)
          .set({ status: "failed" })
          .where(scopedDb.orgFilter(videos, eq(videos.id, id)))

      // The client measured the duration, so this is advisory; the worker's probe is the
      // authoritative check. Refusing here spares an upload the user would see fail later.
      if (body.duration_ms > policy.upload.maxDurationMs) {
        await markFailed()
        return jsonError(
          `Recording is longer than the ${policy.upload.maxDurationMs / 60_000}-minute limit`,
          400
        )
      }

      // Client SAS credentials remain scoped to the upload paths. Readers and
      // analysis workers switch to server-owned copies only after both complete.
      let original: { blobPath: string }
      try {
        original = await finalizeBlob(video.blobPath, video.sizeBytes, {
          maxBytes: policy.upload.maxBytes,
        })
      } catch (error) {
        // A blob that broke the size rules is already deleted. Record the failure in this
        // transaction so the recording stops waiting for completion.
        if (error instanceof BlobFinalizationError && error.rejected) {
          await markFailed()
          return jsonError(error.message, error.status)
        }
        throw error
      }
      let poster: { blobPath: string } | null = null
      if (body.poster_uploaded && video.posterBlobPath) {
        try {
          poster = await finalizeBlob(video.posterBlobPath, null, {
            maxBytes: policy.upload.maxPosterBytes,
          })
        } catch (error) {
          // An oversized poster is deleted and dropped; the worker extracts its own poster.
          if (!(error instanceof BlobFinalizationError && error.rejected)) throw error
        }
      }

      const [updated] = await scopedDb.db
        .update(videos)
        .set({
          blobPath: original.blobPath,
          durationMs: body.duration_ms,
          width: body.width,
          height: body.height,
          hasAudio: body.has_audio,
          posterBlobPath: poster?.blobPath ?? null,
          status: "uploaded",
        })
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
        .returning()

      return NextResponse.json({ video: serializeVideo(updated) })
    })
  } catch (error) {
    if (error instanceof BlobFinalizationError) return jsonError(error.message, error.status)
    return handleRouteError(error)
  }
}
