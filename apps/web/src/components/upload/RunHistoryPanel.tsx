"use client"

import { useState } from "react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { ReanalyzeDialog } from "@/components/upload/ReanalyzeDialog"

type RunHistoryItem = {
  id: string
  pipeline_version: string
  status: string
  total_score: number | null
  config: Record<string, unknown>
  config_source: string | null
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
  const [localRuns, setLocalRuns] = useState(runs)
  const currentRun =
    localRuns.find((run) => run.superseded_by === null) ?? localRuns[0] ?? null

  return (
    <div className="rounded-lg border bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Run history</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Previous analyses for this recording.
          </p>
        </div>
        <ReanalyzeDialog
          videoId={videoId}
          currentConfig={currentRun?.config ?? null}
          currentConfigSource={currentRun?.config_source ?? null}
          onCreated={(analysis) => {
            setLocalRuns((current) => [
              {
                id: analysis.id,
                pipeline_version: analysis.pipeline_version ?? "current",
                status: analysis.status,
                total_score: null,
                config: analysis.config ?? {},
                config_source: analysis.config_source ?? null,
                created_at: analysis.timestamps.created_at,
                completed_at: analysis.timestamps.completed_at,
                superseded_by: analysis.superseded_by,
              },
              ...current.map((run) =>
                run.superseded_by === null
                  ? { ...run, superseded_by: analysis.id }
                  : run
              ),
            ])
          }}
        />
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
    </div>
  )
}
