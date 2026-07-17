import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"

import { tasks, videos } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { serializeVideo } from "@/lib/video-response"
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
