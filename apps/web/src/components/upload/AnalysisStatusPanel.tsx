"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { estimateRemainingMs, formatEta } from "@/lib/eta"

type AnalysisStatus = "queued" | "running" | "succeeded" | "partial" | "failed"
type AnalysisErrorCode =
  | "no_audio"
  | "too_long"
  | "corrupt_file"
  | "transient"
  | "unknown"

type AnalysisPayload = {
  id: string
  video_id: string
  status: AnalysisStatus
  stage: string
  progress_pct: number
  stage_detail: string | null
  error_code: AnalysisErrorCode | null
  timestamps: {
    created_at: string
    updated_at: string
    started_at: string | null
    completed_at: string | null
  }
}

type SerializedMeasure = {
  id: string
  kind: string
  t_start_ms: number
  value_num: number | null
  value_text: string | null
}

type TeaserState = {
  contextSwitches: number
  utterances: number
  latestUtterance: string | null
  positiveSentiment: number
  negativeSentiment: number
  hasSentiment: boolean
}

type Props = {
  videoId: string
  videoStatus: "uploading" | "uploaded" | "failed"
  initialAnalysis: AnalysisPayload | null
  /** Video duration used for ETA estimation. */
  videoDurationMs?: number | null
}

const stages = [
  { id: "queued", label: "Queued" },
  { id: "claim", label: "Claimed" },
  { id: "probe", label: "Probe" },
  { id: "normalize", label: "Normalize" },
  { id: "finalize", label: "Finalize" },
]

const terminalStatuses = new Set<AnalysisStatus>([
  "succeeded",
  "partial",
  "failed",
])

function isTerminal(status: AnalysisStatus) {
  return terminalStatuses.has(status)
}

function failureCopy(code: AnalysisErrorCode | null) {
  switch (code) {
    case "too_long":
      return "This video is over the 20-minute analysis limit."
    case "corrupt_file":
      return "The worker could not read this video file."
    case "no_audio":
      return "No narration audio was available for the requested stage."
    case "transient":
      return "The worker hit a temporary processing error."
    default:
      return "The worker could not finish this analysis."
  }
}

async function readAnalysis(id: string) {
  const response = await fetch(`/api/analyses/${id}`)
  if (!response.ok) throw new Error("Failed to load analysis")
  const body = (await response.json()) as { analysis: AnalysisPayload }
  return body.analysis
}

async function readMeasures(runId: string): Promise<TeaserState> {
  const response = await fetch(`/api/analyses/${runId}/measures?limit=500`)
  if (!response.ok) return emptyTeaser()
  const body = (await response.json()) as { measures: SerializedMeasure[] }
  return computeTeaser(body.measures)
}

function emptyTeaser(): TeaserState {
  return {
    contextSwitches: 0,
    utterances: 0,
    latestUtterance: null,
    positiveSentiment: 0,
    negativeSentiment: 0,
    hasSentiment: false,
  }
}

function computeTeaser(rows: SerializedMeasure[]): TeaserState {
  let contextSwitches = 0
  let utterances = 0
  let latestUtterance: { ms: number; text: string } | null = null
  let positiveSentiment = 0
  let negativeSentiment = 0

  for (const m of rows) {
    if (m.kind === "context_switch") {
      contextSwitches++
    } else if (m.kind === "utterance") {
      utterances++
      if (
        m.value_text &&
        (latestUtterance === null || m.t_start_ms > latestUtterance.ms)
      ) {
        latestUtterance = { ms: m.t_start_ms, text: m.value_text }
      }
    } else if (m.kind === "sentiment" && m.value_num !== null) {
      if (m.value_num > 0.15) positiveSentiment++
      else if (m.value_num < -0.15) negativeSentiment++
    }
  }

  return {
    contextSwitches,
    utterances,
    latestUtterance: latestUtterance?.text ?? null,
    positiveSentiment,
    negativeSentiment,
    hasSentiment: positiveSentiment > 0 || negativeSentiment > 0,
  }
}

/** Live tallies shown while the analysis is running. */
function FoundSoFarTeasers({ teaser }: { teaser: TeaserState }) {
  const hasAny =
    teaser.contextSwitches > 0 || teaser.utterances > 0 || teaser.hasSentiment
  if (!hasAny) return null

  return (
    <div
      data-testid="found-so-far"
      className="rounded-md border bg-muted/40 px-3 py-2 space-y-1.5"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Found so far
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {teaser.contextSwitches > 0 && (
          <span className="text-foreground">
            <span className="font-semibold tabular-nums transition-all duration-300">
              {teaser.contextSwitches}
            </span>{" "}
            context switch{teaser.contextSwitches !== 1 ? "es" : ""}
          </span>
        )}
        {teaser.utterances > 0 && (
          <span className="text-foreground">
            <span className="font-semibold tabular-nums transition-all duration-300">
              {teaser.utterances}
            </span>{" "}
            utterance{teaser.utterances !== 1 ? "s" : ""}
          </span>
        )}
        {teaser.hasSentiment && (
          <>
            {teaser.positiveSentiment > 0 && (
              <span className="text-green-700 dark:text-green-400">
                <span className="font-semibold tabular-nums">
                  {teaser.positiveSentiment}
                </span>{" "}
                positive
              </span>
            )}
            {teaser.negativeSentiment > 0 && (
              <span className="text-red-700 dark:text-red-400">
                <span className="font-semibold tabular-nums">
                  {teaser.negativeSentiment}
                </span>{" "}
                negative
              </span>
            )}
          </>
        )}
      </div>
      {teaser.latestUtterance && (
        <p
          className="mt-1 truncate text-xs italic text-muted-foreground transition-all duration-500"
          title={teaser.latestUtterance}
        >
          &ldquo;{teaser.latestUtterance}&rdquo;
        </p>
      )}
    </div>
  )
}

/** Mini report-layout skeleton shown inside the panel at terminal state. */
function ReportPreviewSkeleton() {
  return (
    <div
      data-testid="report-preview-skeleton"
      className="mt-3 overflow-hidden rounded-md border bg-muted/30 p-3 space-y-2"
      aria-hidden="true"
    >
      {/* Score dial row */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-full shrink-0" />
        <div className="flex-1 space-y-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-2 w-16" />
        </div>
      </div>
      {/* Timeline bands */}
      <Skeleton className="h-5 w-full rounded" />
      <Skeleton className="h-5 w-[90%] rounded" />
      {/* Transcript rows */}
      <div className="space-y-1.5 pt-1">
        <div className="flex gap-2">
          <Skeleton className="h-3 w-10 shrink-0" />
          <Skeleton className="h-3 w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-3 w-10 shrink-0" />
          <Skeleton className="h-3 w-[80%]" />
        </div>
      </div>
    </div>
  )
}

export function AnalysisStatusPanel({
  videoId,
  videoStatus,
  initialAnalysis,
  videoDurationMs,
}: Props) {
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(
    initialAnalysis
  )
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [teaser, setTeaser] = useState<TeaserState>(emptyTeaser())

  const canAnalyze = videoStatus === "uploaded"
  const activeStageIndex = useMemo(() => {
    if (!analysis) return -1
    const index = stages.findIndex((stage) => stage.id === analysis.stage)
    if (analysis.status === "succeeded" || analysis.status === "partial") {
      return stages.length - 1
    }
    return index >= 0 ? index : 0
  }, [analysis])

  const eta = useMemo(() => {
    if (!analysis || analysis.status !== "running") return null
    return formatEta(estimateRemainingMs(analysis.progress_pct, videoDurationMs))
  }, [analysis, videoDurationMs])

  const createRun = useCallback(async () => {
    if (!canAnalyze) return
    setCreating(true)
    setError(null)
    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: videoId }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(body?.error ?? "Failed to start analysis")
      }
      const body = (await response.json()) as { analysis: AnalysisPayload }
      setAnalysis(body.analysis)
      setTeaser(emptyTeaser())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis")
    } finally {
      setCreating(false)
    }
  }, [canAnalyze, videoId])

  // Poll status + measures together while analysis is running
  useEffect(() => {
    if (!analysis || isTerminal(analysis.status)) return

    let cancelled = false
    const tick = () => {
      void Promise.all([
        readAnalysis(analysis.id),
        readMeasures(analysis.id),
      ])
        .then(([next, nextTeaser]) => {
          if (!cancelled) {
            setAnalysis(next)
            setTeaser(nextTeaser)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setError("Analysis status is temporarily unavailable.")
          }
        })
    }

    const interval = setInterval(tick, 2500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [analysis])

  return (
    <div className="rounded-lg border bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Analysis</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {analysis
              ? analysis.stage_detail ?? analysis.stage
              : canAnalyze
                ? "Ready to analyze this upload."
                : "Upload must complete before analysis."}
          </p>
        </div>
        <Button
          size="sm"
          disabled={!canAnalyze || creating}
          onClick={createRun}
          variant={analysis?.status === "failed" ? "default" : "outline"}
        >
          {creating ? (
            <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
          ) : analysis?.status === "failed" ? (
            <RotateCcw data-icon="inline-start" className="size-4" />
          ) : (
            <Activity data-icon="inline-start" className="size-4" />
          )}
          {analysis ? "Retry" : "Analyze"}
        </Button>
      </div>

      {analysis && (
        <div className="mt-4 space-y-3">
          {/* Progress bar + ETA */}
          <div className="space-y-1">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full bg-primary transition-[width] duration-700 ease-out",
                  analysis.status === "failed" && "bg-destructive"
                )}
                style={{ width: `${analysis.progress_pct}%` }}
              />
            </div>
            {eta && (
              <p className="text-right text-xs text-muted-foreground transition-opacity duration-300">
                {eta}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            {stages.map((stage, index) => {
              const complete =
                analysis.status === "succeeded" ||
                analysis.status === "partial" ||
                index < activeStageIndex
              const active = index === activeStageIndex && !isTerminal(analysis.status)
              return (
                <div
                  key={stage.id}
                  className="flex items-center gap-2 text-sm"
                >
                  {complete ? (
                    <CheckCircle2 className="size-4 text-green-600" />
                  ) : active ? (
                    <Loader2 className="size-4 animate-spin text-primary" />
                  ) : (
                    <span className="size-4 rounded-full border" />
                  )}
                  <span
                    className={cn(
                      "text-muted-foreground",
                      (complete || active) && "font-medium text-foreground"
                    )}
                  >
                    {stage.label}
                  </span>
                </div>
              )
            })}
          </div>

          {/* "Found so far" teasers — only while running */}
          {analysis.status === "running" && (
            <FoundSoFarTeasers teaser={teaser} />
          )}

          {/* Terminal states */}
          {analysis.status === "succeeded" && (
            <>
              <ReportPreviewSkeleton />
              <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
                Analysis complete.{" "}
                <a
                  href={`/reports/${analysis.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  View report →
                </a>
              </p>
            </>
          )}
          {analysis.status === "partial" && (
            <>
              <ReportPreviewSkeleton />
              <p className="text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
                Partial results available.{" "}
                <a
                  href={`/reports/${analysis.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  View report →
                </a>
              </p>
            </>
          )}
          {analysis.status === "failed" && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              {failureCopy(analysis.error_code)}
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  )
}
