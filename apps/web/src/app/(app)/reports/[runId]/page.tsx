import { and, eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import { redirect } from "next/navigation"

import { db } from "@/db/client"
import { analysisRuns } from "@/db/schema"
import { assembleReportPayload, ReportNotFoundError, ReportNotReadyError } from "@/lib/report-assembly"
import { resolveOrgContext } from "@/lib/with-org"
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

  const payload = await assembleReportPayload(run.id, context.orgId).catch((error: unknown) => {
    if (error instanceof ReportNotFoundError || error instanceof ReportNotReadyError) {
      notFound()
    }
    throw error
  })

  return (
    <>
      {run.status === "partial" && (
        <PartialBanner videoId={run.videoId} warnings={payload.run.warnings} />
      )}
      <ReportShell payload={payload} />
    </>
  )
}
