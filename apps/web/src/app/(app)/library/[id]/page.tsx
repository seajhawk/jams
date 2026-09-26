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

import {
  analysisRuns,
  effortScores,
  goals,
  participants,
  projects,
  tasks,
  variants,
  videos,
} from "@/db/schema"
import { mintReadSas } from "@/lib/blob"
import { formatMs } from "@/lib/format-ms"
import { serializeAnalysisRun } from "@/lib/analyses"
import { withOrg } from "@/lib/with-org"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { AnalysisStatusPanel } from "@/components/upload/AnalysisStatusPanel"
import { DeleteRecordingButton } from "@/components/upload/DeleteRecordingButton"
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

  return withOrg(async ({ scopedDb }) => {
    const [row] = await scopedDb.db
      .select({
        video: videos,
        taskName: tasks.name,
        goalName: goals.name,
        goalId: goals.id,
        project: { id: projects.id, name: projects.name },
        participant: {
          label: participants.label,
          cohorts: participants.cohorts,
        },
        variant: { name: variants.name, build: variants.build },
      })
      .from(videos)
      .leftJoin(
        tasks,
        and(eq(videos.taskId, tasks.id), eq(tasks.orgId, scopedDb.orgId))
      )
      .leftJoin(goals, and(eq(goals.id, tasks.goalId), eq(goals.orgId, scopedDb.orgId)))
      .leftJoin(
        projects,
        and(eq(projects.id, goals.projectId), eq(projects.orgId, scopedDb.orgId))
      )
      .leftJoin(
        participants,
        and(eq(participants.id, videos.participantId), eq(participants.orgId, scopedDb.orgId))
      )
      .leftJoin(
        variants,
        and(eq(variants.id, videos.variantId), eq(variants.orgId, scopedDb.orgId))
      )
      .where(scopedDb.orgFilter(videos, eq(videos.id, id)))
      .limit(1)

    if (!row) notFound()

    const { video, taskName, goalName, goalId, project, participant, variant } = row
    const [[latestRun], runRows] = await Promise.all([
      scopedDb.db
        .select()
        .from(analysisRuns)
        .where(
          scopedDb.orgFilter(
            analysisRuns,
            and(eq(analysisRuns.videoId, video.id), isNull(analysisRuns.supersededBy))
          )
        )
        .orderBy(desc(analysisRuns.createdAt))
        .limit(1),
      scopedDb.db
        .select()
        .from(analysisRuns)
        .where(
          scopedDb.orgFilter(analysisRuns, eq(analysisRuns.videoId, video.id))
        )
        .orderBy(desc(analysisRuns.createdAt)),
    ])

    const scoreRows = runRows.length
      ? await scopedDb.db
        .select({
          runId: effortScores.runId,
          total: effortScores.total,
        })
        .from(effortScores)
        .where(
          scopedDb.orgFilter(
            effortScores,
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
      {/* Where this session lives: Project › Goal › Journey, or back to All sessions */}
      {video.taskId && taskName ? (
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <Link href="/projects" className="hover:underline">
            Projects
          </Link>
          {project?.id && (
            <>
              <span>›</span>
              <Link href={`/projects/${project.id}`} className="hover:underline">
                {project.name}
              </Link>
            </>
          )}
          {goalName && goalId && (
            <>
              <span>›</span>
              <Link href={`/goals/${goalId}`} className="hover:underline">
                {goalName}
              </Link>
            </>
          )}
          <span>›</span>
          <Link href={`/journeys/${video.taskId}`} className="hover:underline">
            {taskName}
          </Link>
        </nav>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
          nativeButton={false}
          render={<Link href="/library" />}
        >
          <ArrowLeft data-icon="inline-start" className="size-4" />
          Back to All sessions
        </Button>
      )}

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
                <MetaRow icon={<Tag className="size-3.5" />} label="Journey">
                  <Link href={`/journeys/${video.taskId}`} className="hover:underline">
                    {taskName}
                  </Link>
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
              {(participant?.label || video.subjectLabel) && (
                <MetaRow
                  icon={<User className="size-3.5" />}
                  label="Participant"
                >
                  <span className="inline-flex flex-wrap items-center justify-end gap-1">
                    {participant?.label ?? video.subjectLabel}
                    {participant?.cohorts?.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </span>
                </MetaRow>
              )}
              {(variant?.name || video.variantLabel) && (
                <MetaRow label="Variant">
                  {variant?.name ?? video.variantLabel}
                  {variant?.build ? ` (${variant.build})` : ""}
                </MetaRow>
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
              config: run.config,
              config_source: run.configSource,
              created_at: run.createdAt.toISOString(),
              completed_at: run.completedAt?.toISOString() ?? null,
              superseded_by: run.supersededBy,
            }))}
          />
          <DeleteRecordingButton videoId={video.id} title={video.title} />
        </aside>
      </div>
      </section>
    )
  })
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
