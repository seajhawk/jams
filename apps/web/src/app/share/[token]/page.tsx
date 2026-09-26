import { and, eq, gt, isNull, sql } from "drizzle-orm"
import { auth } from "@clerk/nextjs/server"
import { headers } from "next/headers"
import { notFound } from "next/navigation"

import { shareLinks } from "@/db/schema"
import {
  assembleReportPayloadInScope,
  ReportNotFoundError,
  ReportNotReadyError,
} from "@/lib/report-assembly"
import { bindOrgToTransaction, withDbTransaction } from "@/lib/with-org"
import { ReportShell } from "@/components/report/ReportShell"
import { isPreviewUserAllowed } from "@/lib/preview-access"
import { shareViewRetryAfter } from "@/lib/rate-limit"

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const dynamic = "force-dynamic"
export const metadata = {
  title: "Shared Report - JAMS",
  robots: {
    index: false,
    follow: false,
  },
}

function ShareViewsLimited({ retryAfterSeconds }: { retryAfterSeconds: number }) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">This shared report is busy</h1>
      <p className="text-muted-foreground" data-testid="share-rate-limited">
        It has been opened too many times in a short period. Please try again in about{" "}
        {minutes === 1 ? "a minute" : `${minutes} minutes`}.
      </p>
    </main>
  )
}

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  if (process.env.JAMS_PREVIEW_USER_IDS !== undefined) {
    const { userId } = await auth()
    if (!isPreviewUserAllowed(userId)) notFound()
  }
  const { token } = await params
  if (!TOKEN_RE.test(token)) notFound()

  // Each view mints a playback SAS, and playback egress is billed per byte, so views are rate
  // limited per client address and per link before any data access.
  const retryAfter = await shareViewRetryAfter(token, await headers())
  if (retryAfter !== null) return <ShareViewsLimited retryAfterSeconds={retryAfter} />

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
