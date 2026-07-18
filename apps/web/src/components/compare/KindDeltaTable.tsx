'use client'

import type { KindDelta } from '@/lib/compare'
import { DeltaChip } from './DeltaChip'

interface KindDeltaTableProps {
  kinds: KindDelta[]
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'context_switch':
      return 'Context switches'
    case 'spoken_word':
      return 'Words spoken'
    case 'utterance':
      return 'Utterances'
    case 'sentiment':
      return 'Neg. sentiment'
    case 'time_segment':
      return 'Duration'
    default:
      return kind.replace(/_/g, ' ')
  }
}

function rateLabel(kind: string): string {
  switch (kind) {
    case 'context_switch':
      return '/min'
    case 'spoken_word':
      return 'wpm'
    case 'utterance':
      return '/min'
    case 'sentiment':
      return 'density'
    case 'time_segment':
      return 'min'
    default:
      return ''
  }
}

export function KindDeltaTable({ kinds }: KindDeltaTableProps) {
  if (kinds.length === 0) return null

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Measure</th>
            <th className="px-3 py-2 text-right font-medium">Rate A</th>
            <th className="px-3 py-2 text-right font-medium">Score A</th>
            <th className="px-3 py-2 text-right font-medium">Rate B</th>
            <th className="px-3 py-2 text-right font-medium">Score B</th>
            <th className="px-3 py-2 text-right font-medium">Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {kinds.map((k) => {
            const unit = rateLabel(k.kind)
            return (
              <tr key={k.kind} className="hover:bg-muted/30">
                <td className="px-3 py-2 font-medium">{kindLabel(k.kind)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {k.rate_a}
                  {unit && (
                    <span className="ml-0.5 text-xs opacity-60">{unit}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {k.normalized_a}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {k.rate_b}
                  {unit && (
                    <span className="ml-0.5 text-xs opacity-60">{unit}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {k.normalized_b}
                </td>
                <td className="px-3 py-2 text-right">
                  <DeltaChip delta={k.normalized_delta} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
