'use client'

import { useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import type { ReportPayload } from '@/lib/report-contract'
import { formatMs } from '@/lib/format-ms'
import { activeMomentId, buildMoments, type Moment, type MomentKind } from '@/lib/report-moments'

type Filter = 'all' | MomentKind

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'negative', label: 'Negative' },
  { value: 'positive', label: 'Positive' },
  { value: 'switch', label: 'Context switches' },
  { value: 'segment', label: 'Segments' },
]

const KIND_STYLE: Record<MomentKind, string> = {
  negative: 'border-red-400',
  positive: 'border-green-400',
  switch: 'border-amber-400',
  segment: 'border-indigo-400',
}

interface HighlightsTabProps {
  payload: ReportPayload
  currentTimeMs: number
  /** Jump to this moment and play it. `tMs` is the moment's own time; the shell adds the lead-in. */
  onPlayMoment: (tMs: number) => void
}

export function HighlightsTab({ payload, currentTimeMs, onPlayMoment }: HighlightsTabProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const moments = useMemo(() => buildMoments(payload), [payload])
  const activeId = activeMomentId(moments, currentTimeMs)

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: moments.length, negative: 0, positive: 0, switch: 0, segment: 0 }
    for (const m of moments) c[m.kind] += 1
    return c
  }, [moments])

  const visible = filter === 'all' ? moments : moments.filter((m) => m.kind === filter)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Moments worth a listen. Select one to jump to it in the video and hear it.
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter highlights">
        {FILTERS.filter((f) => f.value === 'all' || counts[f.value] > 0).map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`text-xs px-2 py-1 rounded-full border transition-colors ${
              filter === f.value
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground'
            }`}
          >
            {f.label} ({counts[f.value]})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No standout moments in this recording.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {visible.map((m) => (
            <MomentRow key={m.id} moment={m} active={m.id === activeId} onPlay={onPlayMoment} />
          ))}
        </ul>
      )}
    </div>
  )
}

function MomentRow({
  moment,
  active,
  onPlay,
}: {
  moment: Moment
  active: boolean
  onPlay: (tMs: number) => void
}) {
  return (
    <li data-testid="highlight-row" data-start-ms={moment.tMs} data-kind={moment.kind}>
      <button
        type="button"
        onClick={() => onPlay(moment.tMs)}
        aria-label={`Play ${moment.title} at ${formatMs(moment.tMs)}`}
        className={`flex w-full items-start gap-3 border-l-[3px] px-3 py-2.5 text-left transition-colors ${KIND_STYLE[moment.kind]} ${
          active ? 'bg-muted' : 'hover:bg-muted/50'
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      >
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <Play className="size-3" aria-hidden />
          {formatMs(moment.tMs)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{moment.title}</span>
            {moment.score !== null && (
              <span className="text-xs text-muted-foreground">
                sentiment {moment.score > 0 ? '+' : ''}
                {moment.score.toFixed(2)}
              </span>
            )}
          </span>
          {moment.detail && (
            <span className="mt-0.5 block text-sm text-muted-foreground">“{moment.detail}”</span>
          )}
        </span>
      </button>
    </li>
  )
}
