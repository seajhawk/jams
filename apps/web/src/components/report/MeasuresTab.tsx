'use client'

import { useState } from 'react'
import type { ReportPayload, MeasureKind } from '@/lib/report-contract'
import { formatMs } from '@/lib/format-ms'

const ALL_KINDS: MeasureKind[] = [
  'context_switch',
  'utterance',
  'spoken_word',
  'time_segment',
  'sentiment',
]

interface MeasuresTabProps {
  payload: ReportPayload
  onSeek: (ms: number) => void
}

export function MeasuresTab({ payload, onSeek }: MeasuresTabProps) {
  const [activeKinds, setActiveKinds] = useState(new Set<MeasureKind>(ALL_KINDS))

  const toggle = (kind: MeasureKind) => {
    setActiveKinds(prev => {
      const next = new Set(prev)
      if (next.has(kind)) {
        next.delete(kind)
      } else {
        next.add(kind)
      }
      return next
    })
  }

  const visible = payload.measures
    .filter(m => activeKinds.has(m.kind))
    .sort((a, b) => a.t_start_ms - b.t_start_ms)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {ALL_KINDS.map(kind => (
          <button
            key={kind}
            onClick={() => toggle(kind)}
            className={`text-xs px-2 py-1 rounded-full border transition-colors ${
              activeKinds.has(kind)
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground'
            }`}
          >
            {kind.replace(/_/g, ' ')}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 pr-4 font-medium">Time</th>
              <th className="pb-2 pr-4 font-medium">Kind</th>
              <th className="pb-2 pr-4 font-medium">Category</th>
              <th className="pb-2 pr-4 font-medium">Value</th>
              <th className="pb-2 font-medium">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(m => (
              <tr
                key={m.id}
                className="border-b hover:bg-muted/50 cursor-pointer"
                onClick={() => onSeek(m.t_start_ms)}
              >
                <td className="py-1.5 pr-4 font-mono text-muted-foreground">
                  {formatMs(m.t_start_ms)}
                </td>
                <td className="py-1.5 pr-4">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted">{m.kind}</span>
                </td>
                <td className="py-1.5 pr-4 text-muted-foreground">{m.category}</td>
                <td className="py-1.5 pr-4">
                  {m.value_num != null ? m.value_num : (m.value_text ?? '—')}
                </td>
                <td className="py-1.5 text-muted-foreground">
                  {Math.round(m.confidence * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
