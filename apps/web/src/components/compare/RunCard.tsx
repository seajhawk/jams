'use client'

import type { ReportPayload } from '@/lib/report-contract'
import type { ScoreDeltas, VideoLabels } from '@/lib/compare'
import { EffortScoreDial } from '@/components/report/EffortScoreDial'
import { Badge } from '@/components/ui/badge'
import { DeltaChip } from './DeltaChip'
import { formatMs } from '@/lib/format-ms'

const CATEGORIES = ['physical', 'cognitive', 'time', 'sentiment'] as const
type Category = (typeof CATEGORIES)[number]

interface RunCardProps {
  payload: ReportPayload
  labels: VideoLabels
  /** When true, render as baseline (no delta chips) */
  isBaseline?: boolean
  /** Score deltas (b - a). Required when !isBaseline */
  scoreDeltas?: ScoreDeltas
  dialTestId?: string
}

export function RunCard({
  payload,
  labels,
  isBaseline = false,
  scoreDeltas,
  dialTestId,
}: RunCardProps) {
  const { video, run, score } = payload

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Title + chips */}
      <div>
        <p className="truncate font-medium text-sm leading-snug">{video.title}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {labels.subject_label && (
            <Badge variant="secondary" className="text-xs">
              {labels.subject_label}
            </Badge>
          )}
          {labels.variant_label && (
            <Badge variant="outline" className="text-xs">
              {labels.variant_label}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {new Date(run.finished_at).toLocaleDateString()}
          </span>
          {run.status === 'partial' && (
            <Badge variant="outline" className="text-xs">
              partial
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {formatMs(video.duration_ms)}
          </span>
        </div>
      </div>

      {/* Dial + component breakdown */}
      <div className="flex items-start gap-4">
        <EffortScoreDial score={score.total} testId={dialTestId ?? 'score-dial'} />
        <div className="flex-1 space-y-1 pt-1">
          {CATEGORIES.map((cat) => {
            const val = score.components[cat as Category]
            const delta = scoreDeltas?.components[cat as Category]
            return (
              <div key={cat} className="flex items-center justify-between gap-2 text-sm">
                <span className="capitalize text-muted-foreground">{cat}</span>
                <div className="flex items-center gap-1.5">
                  <span className="tabular-nums font-medium">{val}</span>
                  {!isBaseline && delta !== undefined && (
                    <DeltaChip delta={delta} data-testid={`delta-chip-${cat}`} />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Total delta chip for B card */}
      {!isBaseline && scoreDeltas !== undefined && (
        <div className="flex items-center justify-between border-t pt-2">
          <span className="text-sm text-muted-foreground">Total score</span>
          <div className="flex items-center gap-2">
            <span className="font-semibold tabular-nums">{score.total}</span>
            <DeltaChip delta={scoreDeltas.total} data-testid="delta-chip-total" />
          </div>
        </div>
      )}
    </div>
  )
}
