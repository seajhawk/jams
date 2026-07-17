import { and, eq } from "drizzle-orm"
import Link from "next/link"
import { notFound } from "next/navigation"
import { redirect } from "next/navigation"

import { db } from "@/db/client"
import { analysisRuns } from "@/db/schema"
import { assembleReportPayload, ReportNotFoundError, ReportNotReadyError } from "@/lib/report-assembly"
import { resolveOrgContext } from "@/lib/with-org"
import { Badge } from "@/components/ui/badge"
import { ReportShell } from "@/components/report/ReportShell"
import { FailedRunBanner, PartialBanner } from "./report-banners"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId } = await params
  if (!UUID_RE.test(runId)) return { title: "Not Found - JAMS" }
  return { title: "Report - JAMS" }
}

export default async function ReportPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId } = await params
  if (!UUID_RE.test(runId)) notFound()

  const context = await resolveOrgContext()

  const [run] = await db
    .select()
    .from(analysisRuns)
    .where(
      and(eq(analysisRuns.id, runId), eq(analysisRuns.orgId, context.orgId))
    )
    .limit(1)

  if (!run) notFound()

  if (run.status === "failed") {
    return (
      <section className="mx-auto w-full max-w-2xl px-4">
        <FailedRunBanner videoId={run.videoId} errorCode={run.errorCode ?? null} />
      </section>
    )
  }

  if (run.status === "queued" || run.status === "running") {
    redirect(`/library/${run.videoId}`)
  }

  const [newerRun] = run.supersededBy
    ? await db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.id, run.supersededBy),
          eq(analysisRuns.orgId, context.orgId)
        )
      )
      .limit(1)
    : []

  const payload = await assembleReportPayload(run.id, context.orgId).catch((error: unknown) => {
    if (error instanceof ReportNotFoundError || error instanceof ReportNotReadyError) {
      notFound()
    }
    throw error
  })

  return (
    <>
      {newerRun && (
        <SupersededRunBanner
          runId={newerRun.id}
          status={newerRun.status}
        />
      )}
      {run.status === "partial" && (
        <PartialBanner videoId={run.videoId} warnings={payload.run.warnings} />
      )}
      <ReportShell payload={payload} />
    </>
  )
}

function SupersededRunBanner({
  runId,
  status,
}: {
  runId: string
  status: string
}) {
  const reportReady = status === "succeeded" || status === "partial"

  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-muted/50 px-4 py-3">
      <Badge variant="outline">Older analysis</Badge>
      <p className="flex-1 text-sm text-muted-foreground">
        {reportReady
          ? "A newer analysis exists."
          : "A newer analysis is processing."}
      </p>
      {reportReady && (
        <Link href={`/reports/${runId}`} className="text-sm font-medium underline underline-offset-2">
          View newer report
        </Link>
      )}
    </div>
  )
}
