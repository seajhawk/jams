"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Activity, CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

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

type Props = {
  videoId: string
  videoStatus: "uploading" | "uploaded" | "failed"
  initialAnalysis: AnalysisPayload | null
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

export function AnalysisStatusPanel({
  videoId,
  videoStatus,
  initialAnalysis,
}: Props) {
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(
    initialAnalysis
  )
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canAnalyze = videoStatus === "uploaded"
  const activeStageIndex = useMemo(() => {
    if (!analysis) return -1
    const index = stages.findIndex((stage) => stage.id === analysis.stage)
    if (analysis.status === "succeeded" || analysis.status === "partial") {
      return stages.length - 1
    }
    return index >= 0 ? index : 0
  }, [analysis])

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis")
    } finally {
      setCreating(false)
    }
  }, [canAnalyze, videoId])

  useEffect(() => {
    if (!analysis || isTerminal(analysis.status)) return

    let cancelled = false
    const interval = setInterval(() => {
      void readAnalysis(analysis.id)
        .then((next) => {
          if (!cancelled) setAnalysis(next)
        })
        .catch(() => {
          if (!cancelled) {
            setError("Analysis status is temporarily unavailable.")
          }
        })
    }, 2500)

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
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full bg-primary transition-all",
                analysis.status === "failed" && "bg-destructive"
              )}
              style={{ width: `${analysis.progress_pct}%` }}
            />
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

          {analysis.status === "succeeded" && (
            <p className="text-sm text-green-700 dark:text-green-400">
              Analysis complete. Report coming in F4.
            </p>
          )}
          {analysis.status === "partial" && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Analysis finished with partial results. Report coming in F4.
            </p>
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
