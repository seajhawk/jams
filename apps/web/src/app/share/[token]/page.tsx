import { and, eq, gt, isNull } from "drizzle-orm"
import { notFound } from "next/navigation"

import { shareLinks } from "@/db/schema"
import {
  assembleReportPayloadInScope,
  ReportNotFoundError,
  ReportNotReadyError,
} from "@/lib/report-assembly"
import { bindOrgToTransaction, withDbTransaction } from "@/lib/with-org"
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

  return withDbTransaction(async (tx) => {
    const [link] = await tx
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

    const scopedDb = await bindOrgToTransaction(tx, link.orgId)
    const payload = await assembleReportPayloadInScope(
      link.runId,
      link.orgId,
      scopedDb
    ).catch((error: unknown) => {
      if (
        error instanceof ReportNotFoundError ||
        error instanceof ReportNotReadyError
      ) {
        notFound()
      }
      throw error
    })

    return <ReportShell payload={payload} readOnly />
  })
}
