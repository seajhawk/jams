"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Activity,
  ArrowRight,
  FileVideo,
  Loader2,
  RotateCcw,
  Upload,
} from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatMs } from "@/lib/format-ms"
import { cn } from "@/lib/utils"
import { UploadDialog } from "./UploadDialog"
import { ComparePicker } from "@/components/compare/ComparePicker"

interface VideoRecord {
  id: string
  task_id: string | null
  task_name: string | null
  title: string
  blob_path: string
  poster_blob_path: string | null
  size_bytes: number | null
  content_type: string | null
  duration_ms: number | null
  width: number | null
  height: number | null
  fps: number | null
  has_audio: boolean | null
  subject_label: string | null
  variant_label: string | null
  status: "uploading" | "uploaded" | "failed"
  uploaded_by: string
  created_at: string
  latest_run: { id: string; status: string } | null
}

interface TaskRecord {
  id: string
  name: string
}

// Lazily fetches the poster SAS URL when a card mounts
function usePosterSas(videoId: string, hasPoster: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(hasPoster)

  useEffect(() => {
    if (!hasPoster) return // loading is already false (initialized as hasPoster)
    let cancelled = false
    fetch(`/api/videos/${videoId}/playback-sas`)
      .then(
        (r) =>
          r.json() as Promise<{ poster?: { url: string } | null }>
      )
      .then(({ poster }) => {
        if (!cancelled) {
          setUrl(poster?.url ?? null)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [videoId, hasPoster])

  return { url, loading }
}

function StatusBadge({ status }: { status: VideoRecord["status"] }) {
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
  return (
    <Badge variant="destructive" className="text-xs">
      Failed
    </Badge>
  )
}

function VideoCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Skeleton className="aspect-video w-full" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-7 w-full" />
      </div>
    </div>
  )
}

function VideoCard({
  video,
  highlighted,
}: {
  video: VideoRecord
  highlighted: boolean
}) {
  const { url: posterUrl, loading: posterLoading } = usePosterSas(
    video.id,
    video.poster_blob_path !== null
  )
  const router = useRouter()
  const [starting, setStarting] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)

  async function startAnalysis() {
    if (video.status !== "uploaded" || starting) return
    setStarting(true)
    setAnalysisError(null)
    try {
      const res = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: video.id }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(body?.error ?? "Failed to start analysis")
      }
      router.push(`/library/${video.id}`)
    } catch (err) {
      setAnalysisError(
        err instanceof Error ? err.message : "Failed to start analysis"
      )
    } finally {
      setStarting(false)
    }
  }

  return (
    <div
      data-testid="video-card"
      data-video-title={video.title}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md",
        highlighted && "ring-2 ring-primary ring-offset-1"
      )}
    >
      {/* Poster */}
      <button
        type="button"
        className="w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={() => router.push(`/library/${video.id}`)}
        aria-label={`Open ${video.title}`}
      >
        <div className="relative aspect-video overflow-hidden bg-muted">
          {posterLoading ? (
            <Skeleton className="absolute inset-0 rounded-none" />
          ) : posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={posterUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <FileVideo className="size-8 text-muted-foreground/40" />
            </div>
          )}
          {/* Duration overlay */}
          {video.duration_ms !== null && (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">
              {formatMs(video.duration_ms)}
            </span>
          )}
        </div>
      </button>

      {/* Card body */}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <button
          type="button"
          className="text-left"
          onClick={() => router.push(`/library/${video.id}`)}
        >
          <p className="truncate text-sm font-medium leading-none">
            {video.title}
          </p>
        </button>

        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={video.status} />
          {video.task_name && (
            <Badge variant="outline" className="text-xs">
              {video.task_name}
            </Badge>
          )}
          {video.subject_label && (
            <Badge variant="secondary" className="text-xs">
              {video.subject_label}
            </Badge>
          )}
          {video.variant_label && (
            <Badge variant="secondary" className="text-xs">
              {video.variant_label}
            </Badge>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {video.latest_run &&
          (video.latest_run.status === "succeeded" ||
            video.latest_run.status === "partial") ? (
            <Button
              variant="default"
              size="sm"
              className="w-full"
              render={<Link href={`/reports/${video.latest_run.id}`} />}
            >
              <ArrowRight data-icon="inline-start" className="size-4" />
              View report
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={video.status !== "uploaded" || starting}
              className="w-full"
              onClick={startAnalysis}
            >
              {starting ? (
                <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
              ) : (
                <Activity data-icon="inline-start" className="size-4" />
              )}
              Analyze
            </Button>
          )}
          {analysisError && (
            <p className="text-xs leading-5 text-destructive">{analysisError}</p>
          )}
        </div>
      </div>
    </div>
  )
}

export function LibraryContent() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const taskFilter = searchParams.get("task_id") ?? ""
  const statusFilter = searchParams.get("status") ?? ""
  const newVideoId = searchParams.get("new") ?? ""

  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [allTasks, setAllTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const hasFilters = Boolean(taskFilter || statusFilter)

  const loadVideos = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (taskFilter) p.set("task_id", taskFilter)
      if (statusFilter) p.set("status", statusFilter)
      const res = await fetch(`/api/videos?${p}`)
      if (!res.ok) throw new Error("Failed to load videos")
      const { videos: v } = (await res.json()) as { videos: VideoRecord[] }
      setVideos(v)
    } catch {
      setError(
        "Failed to load your library. Check your connection and try again."
      )
    } finally {
      setLoading(false)
    }
  }, [taskFilter, statusFilter])

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks")
      if (!res.ok) return
      const { tasks } = (await res.json()) as { tasks: TaskRecord[] }
      setAllTasks(tasks)
    } catch {}
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadVideos()
  }, [loadVideos])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTasks()
  }, [loadTasks])

  // Remove the ?new= param after 3 s so the highlight fades naturally
  useEffect(() => {
    if (!newVideoId) return
    const t = setTimeout(() => {
      const p = new URLSearchParams(searchParams.toString())
      p.delete("new")
      const qs = p.toString()
      router.replace(qs ? `/library?${qs}` : "/library")
    }, 3000)
    return () => clearTimeout(t)
  }, [newVideoId, searchParams, router])

  function handleUploadSuccess(id: string) {
    loadTasks()
    router.push(`/library?new=${id}`)
    // Give the DB a moment to persist before reloading
    setTimeout(loadVideos, 1200)
  }

  const showFilters = !loading && (videos.length > 0 || hasFilters)
  const showTeachingHero =
    !loading && !error && videos.length === 0 && !hasFilters
  const showNoMatches =
    !loading && !error && videos.length === 0 && hasFilters
  const showGrid = !loading && !error && videos.length > 0

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Library</h1>
          <p className="text-sm text-muted-foreground">
            Your journey recordings and effort analyses.
          </p>
        </div>
        <UploadDialog onSuccess={handleUploadSuccess} />
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="flex flex-wrap gap-3">
          <select
            value={taskFilter}
            onChange={(e) => {
              const p = new URLSearchParams(searchParams.toString())
              if (e.target.value) p.set("task_id", e.target.value)
              else p.delete("task_id")
              router.push(`/library?${p}`)
            }}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring"
          >
            <option value="">All tasks</option>
            {allTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => {
              const p = new URLSearchParams(searchParams.toString())
              if (e.target.value) p.set("status", e.target.value)
              else p.delete("status")
              router.push(`/library?${p}`)
            }}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring"
          >
            <option value="">All statuses</option>
            <option value="uploading">Uploading</option>
            <option value="uploaded">Uploaded</option>
            <option value="failed">Failed</option>
          </select>

          {/* Compare button appears when a task filter is active */}
          {taskFilter && (() => {
            const activeTask = allTasks.find((t) => t.id === taskFilter)
            return activeTask ? (
              <ComparePicker taskId={activeTask.id} taskName={activeTask.name} />
            ) : null
          })()}
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <VideoCardSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={loadVideos}>
            <RotateCcw data-icon="inline-start" className="size-4" />
            Try again
          </Button>
        </div>
      )}

      {/* Teaching empty state */}
      {showTeachingHero && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed bg-background p-8 text-center">
            <div className="flex size-12 items-center justify-center rounded-md bg-muted">
              <Upload className="size-5 text-muted-foreground" />
            </div>
            <h2 className="mt-5 text-lg font-medium">
              Upload your first journey
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Add a screen recording with narration. JAMS will turn it into
              timestamped effort, sentiment, and task-flow measures.
            </p>
            <div className="mt-5">
              <UploadDialog onSuccess={handleUploadSuccess} />
            </div>
          </div>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>Sample report</CardTitle>
              <CardDescription>
                Review the seeded report while uploads are being built.
              </CardDescription>
              <CardAction>
                <FileVideo className="size-5 text-muted-foreground" />
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-4">
                <p className="text-sm font-medium">
                  Google Video Analyzer setup
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Interactive timeline, transcript, sentiment, and score
                  breakdown.
                </p>
              </div>
              <Button variant="outline" render={<Link href="/demo/report" />}>
                Open sample report
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* No matches */}
      {showNoMatches && (
        <div className="flex flex-col items-center gap-3 p-12 text-center text-muted-foreground">
          <p className="text-sm">No videos match your filters.</p>
          <Button variant="outline" size="sm" render={<Link href="/library" />}>
            Clear filters
          </Button>
        </div>
      )}

      {/* Video grid */}
      {showGrid && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((v) => (
            <VideoCard
              key={v.id}
              video={v}
              highlighted={v.id === newVideoId}
            />
          ))}
        </div>
      )}
    </section>
  )
}
