import { and, count, desc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm"
import { NextResponse, type NextRequest } from "next/server"

import { analysisRuns, participants, tasks, variants, videos } from "@/db/schema"
import { HttpError, handleRouteError, jsonError, parseJsonBody } from "@/lib/api"
import { mintUploadSas } from "@/lib/blob"
import { assertInOrg } from "@/lib/hierarchy"
import { assertUploadAdmission } from "@/lib/preview-limits"
import {
  createVideoSchema,
  originalBlobPath,
  posterBlobPath,
  videoStatusSchema,
} from "@/lib/videos"
import { serializeVideo } from "@/lib/video-response"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

function addFilter(base: SQL, extra: SQL | undefined) {
  return extra ? and(base, extra) ?? base : base
}

export async function GET(request: NextRequest) {
  try {
    const taskId = request.nextUrl.searchParams.get("task_id")
    const status = request.nextUrl.searchParams.get("status")
    // Archived recordings are hidden by default so the library stays usable. "archived" shows only
    // those, "all" shows both; anything else is rejected rather than silently treated as the default.
    const archived = request.nextUrl.searchParams.get("archived") ?? "active"
    if (!["active", "archived", "all"].includes(archived)) {
      return jsonError("Invalid archived filter", 400)
    }

    if (taskId && !createVideoSchema.shape.task_id.safeParse(taskId).success) {
      return jsonError("Invalid task_id", 400)
    }

    if (status && !videoStatusSchema.safeParse(status).success) {
      return jsonError("Invalid status", 400)
    }

    return await withOrg(async ({ orgId, scopedDb }) => {
      let where = scopedDb.orgFilter(videos)
      where = addFilter(where, taskId ? eq(videos.taskId, taskId) : undefined)
      where = addFilter(
        where,
        status ? eq(videos.status, videoStatusSchema.parse(status)) : undefined
      )
      where = addFilter(
        where,
        archived === "active"
          ? isNull(videos.archivedAt)
          : archived === "archived"
            ? isNotNull(videos.archivedAt)
            : undefined
      )

      const rows = await scopedDb.db
        .select({ video: videos, taskName: tasks.name })
        .from(videos)
        .leftJoin(
          tasks,
          and(eq(videos.taskId, tasks.id), eq(tasks.orgId, orgId))
        )
        .where(where)
        .orderBy(desc(videos.createdAt))

      const videoIds = rows.map((r) => r.video.id)
      const latestRunMap = new Map<string, { id: string; status: string }>()

      if (videoIds.length > 0) {
        const runRows = await scopedDb.db
          .select({
            videoId: analysisRuns.videoId,
            id: analysisRuns.id,
            status: analysisRuns.status,
          })
          .from(analysisRuns)
          .where(
            and(
              scopedDb.orgFilter(analysisRuns),
              inArray(analysisRuns.videoId, videoIds),
              isNull(analysisRuns.supersededBy)
            )
          )

        for (const run of runRows) {
          latestRunMap.set(run.videoId, { id: run.id, status: run.status })
        }
      }

      // Independent of the current filters: the library uses it to show "N archived" so hiding
      // your last recording never looks like it disappeared.
      const [archivedTotal] = await scopedDb.db
        .select({ value: count() })
        .from(videos)
        .where(scopedDb.orgFilter(videos, isNotNull(videos.archivedAt)))

      return NextResponse.json({
        videos: rows.map((row) => ({
          ...serializeVideo(row.video, row.taskName),
          latest_run: latestRunMap.get(row.video.id) ?? null,
        })),
        archived_count: Number(archivedTotal?.value ?? 0),
      })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, createVideoSchema)

    return await withOrg(async ({ orgId, userId, scopedDb }) => {
      await assertUploadAdmission(scopedDb, body.size_bytes)

      if (body.task_id) {
        const [task] = await scopedDb.db
          .select({ id: tasks.id })
          .from(tasks)
          .where(scopedDb.orgFilter(tasks, eq(tasks.id, body.task_id)))
          .limit(1)

        if (!task) {
          throw new HttpError(400, "Task not found")
        }
      }

      if (body.participant_id) {
        await assertInOrg(scopedDb, participants, body.participant_id, "Participant")
      }
      if (body.variant_id) {
        // A variant belongs to one journey; it must be the journey this session is filed under.
        const [variant] = await scopedDb.db
          .select({ taskId: variants.taskId })
          .from(variants)
          .where(scopedDb.orgFilter(variants, eq(variants.id, body.variant_id)))
          .limit(1)
        if (!variant) throw new HttpError(400, "Variant not found")
        if (variant.taskId !== body.task_id) {
          throw new HttpError(400, "Variant belongs to a different journey")
        }
      }

      const videoId = crypto.randomUUID()
      const blobPath = originalBlobPath({
        orgId,
        videoId,
        contentType: body.content_type,
      })
      const posterPath = posterBlobPath({ orgId, videoId })

      const [video] = await scopedDb.db
        .insert(videos)
        .values({
          id: videoId,
          orgId,
          taskId: body.task_id,
          title: body.title,
          blobPath,
          posterBlobPath: posterPath,
          sizeBytes: body.size_bytes,
          contentType: body.content_type,
          subjectLabel: body.subject_label,
          variantLabel: body.variant_label,
          participantId: body.participant_id,
          variantId: body.variant_id,
          status: "uploading",
          uploadedBy: userId,
        })
        .returning()

      const [upload, posterUpload] = await Promise.all([
        mintUploadSas(blobPath, body.content_type),
        mintUploadSas(posterPath, "image/jpeg"),
      ])

      return NextResponse.json(
        {
          video_id: video.id,
          video: serializeVideo(video),
          upload,
          poster_upload: posterUpload,
        },
        { status: 201 }
      )
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
