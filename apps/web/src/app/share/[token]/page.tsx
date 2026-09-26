import { and, eq, gt, isNull, sql } from "drizzle-orm"
import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { shareLinks } from "@/db/schema"
import {
  assembleReportPayloadInScope,
  ReportNotFoundError,
  ReportNotReadyError,
} from "@/lib/report-assembly"
import { bindOrgToTransaction, withDbTransaction } from "@/lib/with-org"
import { ReportShell } from "@/components/report/ReportShell"
import { publicShareLinksEnabled } from "@/lib/contact"
import { isPreviewUserAllowed } from "@/lib/preview-access"

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
  // During the invitation-only preview, share links open only for invited accounts unless Chris
  // turns on public share links (JAMS_PUBLIC_SHARE_LINKS=1). The token is still validated below
  // and RLS reveals only the link whose token was presented.
  if (process.env.JAMS_PREVIEW_USER_IDS !== undefined && !publicShareLinksEnabled()) {
    const { userId } = await auth()
    if (!isPreviewUserAllowed(userId)) notFound()
  }
  const { token } = await params
  if (!TOKEN_RE.test(token)) notFound()

  return withDbTransaction(async (tx) => {
    // RLS reveals only the share link whose token was presented (migration 0014). Scoped to this
    // transaction, so it cannot leak into another request on the same pooled connection.
    await tx.execute(sql`select set_config('app.share_token', ${token}, true)`)
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
