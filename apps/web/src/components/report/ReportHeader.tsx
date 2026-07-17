'use client'

import type { ReportPayload, MeasureKind } from '@/lib/report-contract'
import { normalize, score } from '@/lib/effort-score'
import { Badge } from '@/components/ui/badge'
import { EffortScoreDial } from './EffortScoreDial'
import { formatMs } from '@/lib/format-ms'

function bandColor(value: number): string {
  if (value <= 33) return 'text-green-500'
  if (value <= 66) return 'text-amber-500'
  return 'text-red-500'
}

interface ReportHeaderProps {
  payload: ReportPayload
  weights: Partial<Record<MeasureKind, number>>
  currentTimeMs: number
}

export function ReportHeader({ payload, weights, currentTimeMs }: ReportHeaderProps) {
  const normalized = normalize(payload.measures, payload.video, payload.score.profile.normalization)
  const liveScore = score(normalized, weights)

  return (
    <header className="sticky top-0 z-40 bg-background border-b px-4 py-3 flex items-center gap-3 flex-wrap">
      <span className="font-semibold">{payload.task?.name ?? 'Untitled task'}</span>
      <span className="text-muted-foreground">—</span>
      <span className="text-muted-foreground">{payload.video.title}</span>
      <Badge variant="secondary" className="text-xs">DEMO</Badge>
      <span className="text-muted-foreground text-sm">
        {new Date(payload.run.finished_at).toLocaleString()}
      </span>
      <Badge variant={payload.run.status === 'succeeded' ? 'default' : 'outline'}>
        {payload.run.status}
      </Badge>
      <div className="flex-1" />
      {(['physical', 'cognitive', 'time', 'sentiment'] as const).map(cat => (
        <div key={cat} className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground capitalize">{cat}</span>
          <span className={bandColor(liveScore.components[cat])}>{liveScore.components[cat]}</span>
        </div>
      ))}
      <span className="text-muted-foreground text-xs font-mono">{formatMs(currentTimeMs)}</span>
      <EffortScoreDial score={liveScore.total} />
    </header>
  )
}
