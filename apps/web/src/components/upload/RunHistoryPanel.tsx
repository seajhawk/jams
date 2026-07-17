"use client"

import { useCallback, useState } from "react"
import { Loader2, RotateCcw } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type RunHistoryItem = {
  id: string
  pipeline_version: string
  status: string
  total_score: number | null
  created_at: string
  completed_at: string | null
  superseded_by: string | null
}

export function RunHistoryPanel({
  videoId,
  runs,
}: {
  videoId: string
  runs: RunHistoryItem[]
}) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localRuns, setLocalRuns] = useState(runs)

  const reanalyze = useCallback(async () => {
    setCreating(true)
    setError(null)
    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: videoId }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? "Failed to start analysis")
      }
      const body = (await response.json()) as {
        analysis: {
          id: string
          pipeline_version?: string
          status: string
          superseded_by: string | null
          timestamps: { created_at: string; completed_at: string | null }
        }
      }
      setLocalRuns((current) => [
        {
          id: body.analysis.id,
          pipeline_version: body.analysis.pipeline_version ?? "current",
          status: body.analysis.status,
          total_score: null,
          created_at: body.analysis.timestamps.created_at,
          completed_at: body.analysis.timestamps.completed_at,
          superseded_by: body.analysis.superseded_by,
        },
        ...current.map((run) =>
          run.superseded_by === null ? { ...run, superseded_by: body.analysis.id } : run
        ),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis")
    } finally {
      setCreating(false)
    }
  }, [videoId])

  return (
    <div className="rounded-lg border bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Run history</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Previous analyses for this recording.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={creating} onClick={reanalyze}>
          {creating ? (
            <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
          ) : (
            <RotateCcw data-icon="inline-start" className="size-4" />
          )}
          Re-analyze
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        {localRuns.length === 0 && (
          <p className="text-sm text-muted-foreground">No analysis runs yet.</p>
        )}
        {localRuns.map((run) => {
          const scored = run.status === "succeeded" || run.status === "partial"
          return (
            <div key={run.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {new Date(run.created_at).toLocaleString()}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {run.pipeline_version}
                  </p>
                </div>
                <Badge variant={scored ? "secondary" : "outline"}>{run.status}</Badge>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {run.total_score === null ? "No score yet" : `Score ${run.total_score}`}
                </span>
                {scored && (
                  <Link
                    href={`/reports/${run.id}`}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    View
                  </Link>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  )
}
