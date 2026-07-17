import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/db/client"
import { analysisRuns, videos } from "@/db/schema"
import { handleRouteError, jsonError } from "@/lib/api"
import { computeComparison } from "@/lib/compare"
import { assembleReportPayload } from "@/lib/report-assembly"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const uuidSchema = z.string().uuid()

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const runsParam = url.searchParams.get("runs") ?? ""
    const parts = runsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    if (
      parts.length !== 2 ||
      !uuidSchema.safeParse(parts[0]).success ||
      !uuidSchema.safeParse(parts[1]).success
    ) {
      return jsonError(
        "runs parameter must be exactly two valid UUIDs separated by a comma",
        400,
      )
    }

    const [idA, idB] = parts as [string, string]

    if (idA === idB) {
      return jsonError("Both run IDs must be different", 400)
    }

    return await withOrg(async ({ orgId }) => {
      // Fetch both runs, org-scoped
      const runs = await db
        .select()
        .from(analysisRuns)
        .where(
          and(
            eq(analysisRuns.orgId, orgId),
            inArray(analysisRuns.id, [idA, idB]),
          ),
        )

      const runA = runs.find((r) => r.id === idA)
      const runB = runs.find((r) => r.id === idB)

      if (!runA || !runB) {
        return jsonError("One or more runs not found for this organization", 404)
      }

      const readyStatuses = ["succeeded", "partial"] as const
      type ReadyStatus = (typeof readyStatuses)[number]
      const isReady = (s: string): s is ReadyStatus =>
        readyStatuses.includes(s as ReadyStatus)

      if (!isReady(runA.status) || !isReady(runB.status)) {
        return jsonError(
          "Both runs must have status 'succeeded' or 'partial'",
          400,
        )
      }

      // Check same task_id via their videos
      const videoRows = await db
        .select()
        .from(videos)
        .where(
          and(
            eq(videos.orgId, orgId),
            inArray(videos.id, [runA.videoId, runB.videoId]),
          ),
        )

      const videoA = videoRows.find((v) => v.id === runA.videoId)
      const videoB = videoRows.find((v) => v.id === runB.videoId)

      if (!videoA || !videoB) {
        return jsonError("Videos for these runs could not be found", 404)
      }

      if (!videoA.taskId || videoA.taskId !== videoB.taskId) {
        return jsonError(
          "Both runs must belong to the same task to compare",
          400,
        )
      }

      // Assemble both report payloads
      const [a, b] = await Promise.all([
        assembleReportPayload(idA, orgId),
        assembleReportPayload(idB, orgId),
      ])

      const comparison = computeComparison(
        a,
        b,
        {
          subject_label: videoA.subjectLabel,
          variant_label: videoA.variantLabel,
        },
        {
          subject_label: videoB.subjectLabel,
          variant_label: videoB.variantLabel,
        },
      )

      return Response.json({ a, b, comparison })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
