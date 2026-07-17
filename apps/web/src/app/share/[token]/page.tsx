import { and, eq, gt, isNull } from "drizzle-orm"
import { notFound } from "next/navigation"

import { db } from "@/db/client"
import { shareLinks } from "@/db/schema"
import {
  assembleReportPayload,
  ReportNotFoundError,
  ReportNotReadyError,
} from "@/lib/report-assembly"
import { ReportShell } from "@/components/report/ReportShell"

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const dynamic = "force-dynamic"
export const metadata = {
  title: "Shared Report - JAMS",
  robots: {
    index: false,
    follow: false,
  },
}

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!TOKEN_RE.test(token)) notFound()

  const [link] = await db
    .select({
      runId: shareLinks.runId,
      orgId: shareLinks.orgId,
    })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.token, token),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, new Date())
      )
    )
    .limit(1)

  if (!link) notFound()

  const payload = await assembleReportPayload(link.runId, link.orgId).catch(
    (error: unknown) => {
      if (error instanceof ReportNotFoundError || error instanceof ReportNotReadyError) {
        notFound()
      }
      throw error
    }
  )

  return <ReportShell payload={payload} readOnly />
}
