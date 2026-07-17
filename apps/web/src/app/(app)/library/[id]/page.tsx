import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import {
  ArrowLeft,
  Calendar,
  Clock,
  Mic,
  Monitor,
  Tag,
  User,
} from "lucide-react"
import Link from "next/link"
import { notFound } from "next/navigation"
import type React from "react"

import { db } from "@/db/client"
import { analysisRuns, effortScores, tasks, videos } from "@/db/schema"
import { mintReadSas } from "@/lib/blob"
import { formatMs } from "@/lib/format-ms"
import { serializeAnalysisRun } from "@/lib/analyses"
import { resolveOrgContext } from "@/lib/with-org"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { AnalysisStatusPanel } from "@/components/upload/AnalysisStatusPanel"
import { RunHistoryPanel } from "@/components/upload/RunHistoryPanel"
import { VideoDetailPlayer } from "@/components/upload/VideoDetailPlayer"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!UUID_RE.test(id)) return { title: "Not Found - JAMS" }
  return { title: "Video - JAMS" }
}

export default async function VideoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!UUID_RE.test(id)) notFound()

  const context = await resolveOrgContext()

  const [row] = await db
    .select({ video: videos, taskName: tasks.name })
    .from(videos)
    .leftJoin(
      tasks,
      and(eq(videos.taskId, tasks.id), eq(tasks.orgId, context.orgId))
    )
    .where(
      and(eq(videos.id, id), eq(videos.orgId, context.orgId))
    )
    .limit(1)

  if (!row) notFound()

  const { video, taskName } = row
  const [[latestRun], runRows] = await Promise.all([
    db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.videoId, video.id),
          eq(analysisRuns.orgId, context.orgId),
          isNull(analysisRuns.supersededBy)
        )
      )
      .orderBy(desc(analysisRuns.createdAt))
      .limit(1),
    db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.videoId, video.id),
          eq(analysisRuns.orgId, context.orgId)
        )
      )
      .orderBy(desc(analysisRuns.createdAt)),
  ])

  const scoreRows = runRows.length
    ? await db
        .select({
          runId: effortScores.runId,
          total: effortScores.total,
        })
        .from(effortScores)
        .where(
          and(
            eq(effortScores.orgId, context.orgId),
            inArray(effortScores.runId, runRows.map((run) => run.id))
          )
        )
    : []
  const scoresByRun = new Map(scoreRows.map((scoreRow) => [scoreRow.runId, scoreRow.total]))

  const [playbackSas, posterSas] = await Promise.all([
    mintReadSas(video.blobPath),
    video.posterBlobPath
      ? mintReadSas(video.posterBlobPath)
      : Promise.resolve(null),
  ])

  const uploadedAt = video.createdAt.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      {/* Back link */}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit"
        nativeButton={false}
        render={<Link href="/library" />}
      >
        <ArrowLeft data-icon="inline-start" className="size-4" />
        Back to Library
      </Button>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* Player */}
        <div className="space-y-3">
          <h1 className="text-xl font-semibold">{video.title}</h1>
          <VideoDetailPlayer src={playbackSas.url} />
        </div>

        {/* Metadata sidebar */}
        <aside className="space-y-4">
          <div className="rounded-xl border bg-card p-4 ring-1 ring-foreground/10">
            <div className="flex items-center justify-between">
              <VideoStatusBadge status={video.status} />
              {video.durationMs !== null && (
                <span className="text-sm text-muted-foreground">
                  {formatMs(video.durationMs)}
                </span>
              )}
            </div>

            <Separator className="my-3" />

            <dl className="space-y-2.5 text-sm">
              {taskName && (
                <MetaRow icon={<Tag className="size-3.5" />} label="Task">
                  {taskName}
                </MetaRow>
              )}
              {video.width !== null && video.height !== null && (
                <MetaRow
                  icon={<Monitor className="size-3.5" />}
                  label="Resolution"
                >
                  {video.width}×{video.height}
                </MetaRow>
              )}
              {video.durationMs !== null && (
                <MetaRow
                  icon={<Clock className="size-3.5" />}
                  label="Duration"
                >
                  {formatMs(video.durationMs)}
                </MetaRow>
              )}
              {video.hasAudio !== null && (
                <MetaRow icon={<Mic className="size-3.5" />} label="Audio">
                  {video.hasAudio ? "Yes" : "No"}
                </MetaRow>
              )}
              {video.subjectLabel && (
                <MetaRow
                  icon={<User className="size-3.5" />}
                  label="Subject"
                >
                  {video.subjectLabel}
                </MetaRow>
              )}
              {video.variantLabel && (
                <MetaRow label="Variant">{video.variantLabel}</MetaRow>
              )}
              <MetaRow
                icon={<Calendar className="size-3.5" />}
                label="Uploaded"
              >
                {uploadedAt}
              </MetaRow>
            </dl>
          </div>

          {/* Poster preview if available */}
          {posterSas && (
            <div className="overflow-hidden rounded-xl border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={posterSas.url}
                alt="Video poster"
                className="aspect-video w-full object-cover"
              />
            </div>
          )}

          <AnalysisStatusPanel
            videoId={video.id}
            videoStatus={video.status}
            initialAnalysis={latestRun ? serializeAnalysisRun(latestRun) : null}
            videoDurationMs={video.durationMs}
          />
          <RunHistoryPanel
            videoId={video.id}
            runs={runRows.map((run) => ({
              id: run.id,
              pipeline_version: run.pipelineVersion,
              status: run.status,
              total_score: scoresByRun.get(run.id) ?? null,
              created_at: run.createdAt.toISOString(),
              completed_at: run.completedAt?.toISOString() ?? null,
              superseded_by: run.supersededBy,
            }))}
          />
        </aside>
      </div>
    </section>
  )
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <dt className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  )
}

function VideoStatusBadge({ status }: { status: string }) {
  if (status === "uploading") {
    return (
      <span className="inline-flex items-center rounded-4xl border border-transparent bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 animate-pulse dark:bg-amber-900/30 dark:text-amber-400">
        Uploading…
      </span>
    )
  }
  if (status === "uploaded") {
    return (
      <span className="inline-flex items-center rounded-4xl border border-transparent bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
        Uploaded
      </span>
    )
  }
  return <Badge variant="destructive">Failed</Badge>
}
