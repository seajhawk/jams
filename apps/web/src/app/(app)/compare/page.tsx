import { inArray } from "drizzle-orm"
import { notFound } from "next/navigation"

import { analysisRuns, videos } from "@/db/schema"
import { computeComparison } from "@/lib/compare"
import {
  assembleReportPayload,
  ReportNotFoundError,
  ReportNotReadyError,
} from "@/lib/report-assembly"
import { withOrg } from "@/lib/with-org"
import { CompareShell } from "@/components/compare/CompareShell"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const metadata = { title: "Compare Reports - JAMS" }

function ErrorPage({ message }: { message: string }) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-4 py-20 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </section>
  )
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { runs: runsRaw } = await searchParams
  const runsParam = Array.isArray(runsRaw) ? runsRaw[0] : (runsRaw ?? "")

  const parts = runsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  if (
    parts.length !== 2 ||
    !UUID_RE.test(parts[0]) ||
    !UUID_RE.test(parts[1]) ||
    parts[0] === parts[1]
  ) {
    notFound()
  }

  const [idA, idB] = parts

  return withOrg(async ({ orgId, scopedDb }) => {
    // Fetch both runs, org-scoped
    const runs = await scopedDb.db
      .select()
      .from(analysisRuns)
      .where(
        scopedDb.orgFilter(analysisRuns, inArray(analysisRuns.id, [idA, idB]))
      )

    const runA = runs.find((r) => r.id === idA)
    const runB = runs.find((r) => r.id === idB)

    if (!runA || !runB) notFound()

    const readyStatuses = ["succeeded", "partial"] as const
    type ReadyStatus = (typeof readyStatuses)[number]
    const isReady = (s: string): s is ReadyStatus =>
      readyStatuses.includes(s as ReadyStatus)

    if (!isReady(runA.status) || !isReady(runB.status)) {
      return (
        <ErrorPage message="Both runs must be succeeded or partial to compare." />
      )
    }

    // Fetch videos to verify same task_id and get labels
    const videoRows = await scopedDb.db
      .select()
      .from(videos)
      .where(
        scopedDb.orgFilter(videos, inArray(videos.id, [runA.videoId, runB.videoId]))
      )

    const videoA = videoRows.find((v) => v.id === runA.videoId)
    const videoB = videoRows.find((v) => v.id === runB.videoId)

    if (!videoA || !videoB) notFound()

    if (!videoA.taskId || videoA.taskId !== videoB.taskId) {
      return (
        <ErrorPage message="Both runs must belong to the same task to compare." />
      )
    }

    // Assemble both payloads (server-side, no extra network hop)
    const assembleOrNull = async (runId: string) => {
      try {
        return await assembleReportPayload(runId, orgId, scopedDb)
      } catch (err) {
        if (
          err instanceof ReportNotFoundError ||
          err instanceof ReportNotReadyError
        ) {
          return null
        }
        throw err
      }
    }

    const [payloadA, payloadB] = await Promise.all([
      assembleOrNull(idA),
      assembleOrNull(idB),
    ])

    if (!payloadA || !payloadB) notFound()

    const comparison = computeComparison(
      payloadA,
      payloadB,
      { subject_label: videoA.subjectLabel, variant_label: videoA.variantLabel },
      { subject_label: videoB.subjectLabel, variant_label: videoB.variantLabel },
    )

    const taskName =
      payloadA.task?.name ?? payloadB.task?.name ?? "Untitled task"

    return (
      <CompareShell
        a={payloadA}
        b={payloadB}
        comparison={comparison}
        taskName={taskName}
      />
    )
  })
}
