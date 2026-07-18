import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { videos } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { mintReadSas } from "@/lib/blob"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    return await withOrg(async ({ scopedDb }) => {
      const [video] = await scopedDb.db
        .select()
        .from(videos)
        .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
        .limit(1)

      if (!video) {
        return jsonError("Not found", 404)
      }

      const [playback, poster] = await Promise.all([
        mintReadSas(video.blobPath),
        video.posterBlobPath ? mintReadSas(video.posterBlobPath) : Promise.resolve(null),
      ])

      return NextResponse.json({ video: playback, poster })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
