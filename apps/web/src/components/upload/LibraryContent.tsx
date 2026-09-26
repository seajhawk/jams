"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowRight,
  FileVideo,
  Loader2,
  MoreHorizontal,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { failureCopy } from "@/lib/analysis-failure"
import { analysisStarted, requestAnalysisNotifications } from "@/lib/analysis-watch"
import { estimateRemainingMs, formatEta } from "@/lib/eta"
import { formatMs } from "@/lib/format-ms"
import { cn } from "@/lib/utils"
import { UploadDialog } from "./UploadDialog"
import { DeleteRecordingDialog } from "./DeleteRecordingButton"
import { useAnalysisProgress, type AnalysisProgress } from "./useAnalysisProgress"
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
  archived_at: string | null
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

/** Hides or restores a recording. Module-level so an Undo toast can call it after the card is gone. */
async function patchArchived(videoId: string, archived: boolean) {
  const res = await fetch(`/api/videos/${videoId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  })
  return res.ok
}

function isRunActive(status: string | undefined) {
  return status === "queued" || status === "running"
}

/**
 * Progress shown over the whole card while an analysis runs. Deliberately large and centred: it is
 * the only thing on the card the user should be looking at, and it blocks clicks through to the
 * recording until the analysis has finished.
 */
function AnalysisOverlay({
  analysis,
  unavailable,
  durationMs,
  onRetry,
  onDismiss,
}: {
  analysis: AnalysisProgress | null
  unavailable: boolean
  durationMs: number | null
  onRetry: () => void
  onDismiss: () => void
}) {
  if (analysis?.status === "failed") {
    return (
      <div
        role="alert"
        data-testid="analysis-overlay"
        className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-background/95 p-6 text-center backdrop-blur-sm"
      >
        <XCircle className="size-10 text-destructive" />
        <div className="space-y-1">
          <p className="text-base font-semibold">Analysis failed</p>
          <p className="text-sm text-muted-foreground">{failureCopy(analysis.error_code)}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={onRetry}>
            <RotateCcw data-icon="inline-start" className="size-4" />
            Retry
          </Button>
          <Button size="sm" variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    )
  }

  const pct = Math.max(0, Math.min(100, Math.round(analysis?.progress_pct ?? 0)))
  const label = !analysis
    ? "Starting analysis…"
    : analysis.status === "queued"
      ? "Queued — waiting for a worker"
      : (analysis.stage_detail ?? analysis.stage)
  const eta = analysis?.status === "running" ? formatEta(estimateRemainingMs(pct, durationMs)) : null

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="analysis-overlay"
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-background/90 p-6 text-center backdrop-blur-sm"
    >
      <p className="text-5xl font-semibold tabular-nums leading-none">{pct}%</p>
      <div
        role="progressbar"
        aria-label="Analysis progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-3 w-full max-w-xs overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        {eta && <p className="text-xs text-muted-foreground">{eta}</p>}
        {unavailable && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Status temporarily unavailable — retrying…
          </p>
        )}
      </div>
    </div>
  )
}

function VideoCard({
  video,
  highlighted,
  archivedView,
  onRemoved,
  onRefresh,
}: {
  video: VideoRecord
  highlighted: boolean
  archivedView: boolean
  /** The recording left the current view (archived, restored, or deleted). */
  onRemoved: (id: string) => void
  /** Something changed server-side; reload the list without a loading flash. */
  onRefresh: () => void
}) {
  const { url: posterUrl, loading: posterLoading } = usePosterSas(
    video.id,
    video.poster_blob_path !== null
  )
  const router = useRouter()
  const [starting, setStarting] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // A run already in flight when the page loads (or started here) is followed in place.
  const [activeRunId, setActiveRunId] = useState<string | null>(
    isRunActive(video.latest_run?.status) ? video.latest_run!.id : null
  )
  // Bridges the gap between a run finishing and the refreshed list arriving.
  const [localRun, setLocalRun] = useState<{ id: string; status: string } | null>(null)
  const latestRun = localRun ?? video.latest_run

  const handleSettled = useCallback(
    (settled: AnalysisProgress) => {
      setLocalRun({ id: settled.id, status: settled.status })
      if (settled.status === "failed") return // stays on screen until dismissed or retried
      setActiveRunId(null)
      // No toast here: AnalysisWatcher announces every completion, on whatever page the user is
      // on, so doing it here as well would double up whenever the library happens to be open.
      onRefresh()
    },
    [onRefresh]
  )
  const { analysis, unavailable } = useAnalysisProgress(activeRunId, handleSettled)

  async function startAnalysis() {
    if (video.status !== "uploaded" || starting || activeRunId) return
    setStarting(true)
    setAnalysisError(null)
    // Still inside the click, so the browser treats this as a user gesture.
    requestAnalysisNotifications()
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
      const body = (await res.json()) as { analysis: { id: string; status: string } }
      // Stay in the library: progress appears as an overlay on this card.
      setLocalRun({ id: body.analysis.id, status: body.analysis.status })
      setActiveRunId(body.analysis.id)
      analysisStarted()
    } catch (err) {
      setAnalysisError(
        err instanceof Error ? err.message : "Failed to start analysis"
      )
    } finally {
      setStarting(false)
    }
  }

  function dismissFailure() {
    setActiveRunId(null)
    onRefresh()
  }

  async function setArchived(next: boolean) {
    if (busy) return
    setBusy(true)
    try {
      if (!(await patchArchived(video.id, next))) throw new Error("archive failed")
      onRemoved(video.id)
      if (next) {
        toast(`Archived “${video.title}”`, {
          action: {
            label: "Undo",
            onClick: () => {
              void patchArchived(video.id, false).then((ok) => {
                if (ok) onRefresh()
                else toast.error("Could not restore the recording. Try again.")
              })
            },
          },
        })
      } else {
        toast(`Restored “${video.title}” to your library`)
      }
    } catch {
      toast.error(
        next
          ? "Could not archive the recording. Try again."
          : "Could not restore the recording. Try again."
      )
      setBusy(false)
    }
  }

  const hasReport = latestRun && (latestRun.status === "succeeded" || latestRun.status === "partial")
  const lastRunFailed = latestRun?.status === "failed"

  return (
    <div
      data-testid="video-card"
      data-video-title={video.title}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md",
        highlighted && "ring-2 ring-primary ring-offset-1"
      )}
    >
      {activeRunId && (
        <AnalysisOverlay
          analysis={analysis}
          unavailable={unavailable}
          durationMs={video.duration_ms}
          onRetry={() => {
            setActiveRunId(null)
            void startAnalysis()
          }}
          onDismiss={dismissFailure}
        />
      )}

      {/* Actions: above the overlay, so a stuck analysis can still be archived or deleted */}
      <div className="absolute right-2 top-2 z-30">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="secondary"
                className="bg-background/85 shadow-sm backdrop-blur"
                aria-label={`Actions for ${video.title}`}
                disabled={busy}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44">
            {archivedView ? (
              <DropdownMenuItem onClick={() => void setArchived(false)}>
                <ArchiveRestore className="size-4" />
                Restore to library
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => void setArchived(true)}>
                <Archive className="size-4" />
                Archive
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <DeleteRecordingDialog
        videoId={video.id}
        title={video.title}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => {
          onRemoved(video.id)
          onRefresh()
        }}
      />

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
          <div className="flex gap-2">
            {hasReport ? (
              <Button
                variant="default"
                size="sm"
                className="flex-1"
                render={<Link href={`/reports/${latestRun.id}`} />}
              >
                <ArrowRight data-icon="inline-start" className="size-4" />
                View report
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={video.status !== "uploaded" || starting || Boolean(activeRunId)}
                className="flex-1"
                onClick={startAnalysis}
              >
                {starting ? (
                  <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
                ) : lastRunFailed ? (
                  <RotateCcw data-icon="inline-start" className="size-4" />
                ) : (
                  <Activity data-icon="inline-start" className="size-4" />
                )}
                {lastRunFailed ? "Retry" : "Analyze"}
              </Button>
            )}
            {video.status === "uploaded" ? (
              <Button variant="outline" size="sm" render={<Link href={`/library/${video.id}`} />}>
                <Play data-icon="inline-start" className="size-4" />
                Play
              </Button>
            ) : (
              // A link cannot be disabled, so an unplayable recording gets a real disabled button.
              <Button variant="outline" size="sm" disabled>
                <Play data-icon="inline-start" className="size-4" />
                Play
              </Button>
            )}
          </div>
          {lastRunFailed && !activeRunId && (
            <p className="text-xs leading-5 text-muted-foreground">Last analysis failed.</p>
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
  const view = searchParams.get("view") === "archived" ? "archived" : "active"

  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [archivedCount, setArchivedCount] = useState(0)
  const [allTasks, setAllTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const hasFilters = Boolean(taskFilter || statusFilter)

  const fetchVideos = useCallback(async () => {
    const p = new URLSearchParams()
    if (taskFilter) p.set("task_id", taskFilter)
    if (statusFilter) p.set("status", statusFilter)
    if (view === "archived") p.set("archived", "archived")
    const res = await fetch(`/api/videos?${p}`)
    if (!res.ok) throw new Error("Failed to load videos")
    const body = (await res.json()) as { videos: VideoRecord[]; archived_count?: number }
    setVideos(body.videos)
    setArchivedCount(body.archived_count ?? 0)
  }, [taskFilter, statusFilter, view])

  const loadVideos = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await fetchVideos()
    } catch {
      setError(
        "Failed to load your library. Check your connection and try again."
      )
    } finally {
      setLoading(false)
    }
  }, [fetchVideos])

  // After an archive, delete, or finished analysis: reconcile with the server without the
  // skeleton flash, and keep whatever is on screen if the refresh itself fails.
  const refreshVideos = useCallback(async () => {
    try {
      await fetchVideos()
    } catch {}
  }, [fetchVideos])

  const handleRemoved = useCallback(
    (id: string) => {
      setVideos((current) => current.filter((v) => v.id !== id))
      void refreshVideos()
    },
    [refreshVideos]
  )

  function setView(next: "active" | "archived") {
    const p = new URLSearchParams(searchParams.toString())
    if (next === "archived") p.set("view", "archived")
    else p.delete("view")
    router.push(`/library?${p}`)
  }

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

  const [expiredHighlightId, setExpiredHighlightId] = useState<string | null>(null)

  // A visual timeout must not navigate: it could cancel opening a video while
  // the destination is still loading.
  useEffect(() => {
    if (!newVideoId) return
    const t = setTimeout(() => {
      setExpiredHighlightId(newVideoId)
    }, 3000)
    return () => clearTimeout(t)
  }, [newVideoId])

  function handleUploadSuccess(id: string) {
    loadTasks()
    router.push(`/library?new=${id}`)
    // Give the DB a moment to persist before reloading
    setTimeout(loadVideos, 1200)
  }

  const showFilters = !loading && (videos.length > 0 || hasFilters)
  const inArchive = view === "archived"
  const showViewToggle = !loading && !error && (archivedCount > 0 || inArchive)
  // Only a genuinely empty library gets the "upload your first journey" pitch. If everything has
  // been archived, say so instead, or hiding your last recording would look like losing it.
  const showTeachingHero =
    !loading && !error && !inArchive && videos.length === 0 && !hasFilters && archivedCount === 0
  const showAllArchived =
    !loading && !error && !inArchive && videos.length === 0 && !hasFilters && archivedCount > 0
  const showArchiveEmpty =
    !loading && !error && inArchive && videos.length === 0
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

      {showViewToggle && (
        <div className="flex gap-1" role="group" aria-label="Library view">
          <Button
            size="sm"
            variant={inArchive ? "outline" : "secondary"}
            aria-pressed={!inArchive}
            onClick={() => setView("active")}
          >
            Library
          </Button>
          <Button
            size="sm"
            variant={inArchive ? "secondary" : "outline"}
            aria-pressed={inArchive}
            onClick={() => setView("archived")}
          >
            <Archive data-icon="inline-start" className="size-4" />
            Archived ({archivedCount})
          </Button>
        </div>
      )}

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
                An example report so you can see what JAMS produces before your first upload.
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

      {showAllArchived && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <Archive className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">Everything is archived</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Your {archivedCount} archived recording{archivedCount === 1 ? "" : "s"} are hidden, not deleted.
          </p>
          <Button variant="outline" size="sm" onClick={() => setView("archived")}>
            View archived
          </Button>
        </div>
      )}

      {showArchiveEmpty && (
        <div className="flex flex-col items-center gap-3 p-12 text-center text-muted-foreground">
          <p className="text-sm">No archived recordings.</p>
          <Button variant="outline" size="sm" onClick={() => setView("active")}>
            Back to library
          </Button>
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
              highlighted={v.id === newVideoId && v.id !== expiredHighlightId}
              archivedView={inArchive}
              onRemoved={handleRemoved}
              onRefresh={refreshVideos}
            />
          ))}
        </div>
      )}
    </section>
  )
}
