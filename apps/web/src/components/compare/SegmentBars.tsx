'use client'

import { cn } from '@/lib/utils'
import type { SegmentAlignment } from '@/lib/compare'

interface SegmentBarsProps {
  segments: SegmentAlignment
  onSeek: (ms: number, run: 'a' | 'b') => void
}

function formatDeltaMs(ms: number): string {
  const abs = Math.abs(ms)
  const sign = ms >= 0 ? '+' : '−'
  if (abs < 1000) return `${sign}${abs}ms`
  if (abs < 60_000) return `${sign}${Math.round(abs / 1000)}s`
  const min = Math.floor(abs / 60_000)
  const sec = Math.round((abs % 60_000) / 1000)
  return `${sign}${min}:${String(sec).padStart(2, '0')}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}:${String(sec).padStart(2, '0')}`
}

export function SegmentBars({ segments, onSeek }: SegmentBarsProps) {
  const { pairs, unmatched_a, unmatched_b, alignment } = segments

  // Compute shared scale: max duration across all pairs + unmatched
  const allDurations = [
    ...pairs.flatMap((p) => [
      p.a_segment.t_end_ms - p.a_segment.t_start_ms,
      p.b_segment.t_end_ms - p.b_segment.t_start_ms,
    ]),
    ...unmatched_a.map((s) => s.t_end_ms - s.t_start_ms),
    ...unmatched_b.map((s) => s.t_end_ms - s.t_start_ms),
  ]

  const maxDuration = Math.max(...allDurations, 1)

  function pct(ms: number) {
    return `${Math.round((ms / maxDuration) * 100)}%`
  }

  return (
    <div
      data-testid="segment-bars"
      className="space-y-5"
    >
      {alignment === 'positional_partial' && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Run counts differ — segments aligned positionally; extras listed as unmatched below.
        </p>
      )}

      {/* Aligned pairs */}
      {pairs.map((pair, i) => {
        const aDur = pair.a_segment.t_end_ms - pair.a_segment.t_start_ms
        const bDur = pair.b_segment.t_end_ms - pair.b_segment.t_start_ms

        return (
          <div key={pair.a_segment.id} className="space-y-1">
            {/* Segment name + delta label */}
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-foreground truncate max-w-[60%]">
                {pair.a_segment.name}
                {pair.a_segment.name !== pair.b_segment.name && (
                  <span className="ml-1 text-muted-foreground">
                    / {pair.b_segment.name}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'text-xs tabular-nums shrink-0',
                  pair.duration_delta_ms < 0
                    ? 'text-green-600 dark:text-green-400'
                    : pair.duration_delta_ms > 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-muted-foreground',
                )}
              >
                {formatDeltaMs(pair.duration_delta_ms)}
              </span>
            </div>

            {/* A bar */}
            <button
              type="button"
              data-testid={`segment-bar-a-${i}`}
              title={`A: ${pair.a_segment.name} (${formatDuration(aDur)}) — click to seek`}
              className="flex h-6 w-full items-center gap-2 rounded group"
              onClick={() => onSeek(pair.a_segment.t_start_ms, 'a')}
            >
              <span className="w-3 shrink-0 text-[10px] text-muted-foreground">A</span>
              <div className="flex-1 rounded bg-muted relative h-5">
                <div
                  className="h-full rounded bg-indigo-400/70 group-hover:bg-indigo-400 transition-colors"
                  style={{ width: pct(aDur) }}
                />
                <span className="absolute inset-y-0 left-1.5 flex items-center text-[10px] text-foreground/80">
                  {formatDuration(aDur)}
                </span>
              </div>
            </button>

            {/* B bar */}
            <button
              type="button"
              data-testid={`segment-bar-b-${i}`}
              title={`B: ${pair.b_segment.name} (${formatDuration(bDur)}) — click to seek`}
              className="flex h-6 w-full items-center gap-2 rounded group"
              onClick={() => onSeek(pair.b_segment.t_start_ms, 'b')}
            >
              <span className="w-3 shrink-0 text-[10px] text-muted-foreground">B</span>
              <div className="flex-1 rounded bg-muted relative h-5">
                <div
                  className="h-full rounded bg-teal-400/70 group-hover:bg-teal-400 transition-colors"
                  style={{ width: pct(bDur) }}
                />
                <span className="absolute inset-y-0 left-1.5 flex items-center text-[10px] text-foreground/80">
                  {formatDuration(bDur)}
                </span>
              </div>
            </button>
          </div>
        )
      })}

      {/* Unmatched segments */}
      {(unmatched_a.length > 0 || unmatched_b.length > 0) && (
        <div className="space-y-3 opacity-50">
          <p className="text-xs font-medium text-muted-foreground">Unaligned segments</p>

          {unmatched_a.map((seg) => {
            const dur = seg.t_end_ms - seg.t_start_ms
            return (
              <div key={seg.id} className="space-y-1">
                <span className="text-xs text-muted-foreground truncate block">
                  {seg.name}{' '}
                  <span className="italic">A only</span>
                </span>
                <button
                  type="button"
                  data-testid="segment-bar-unmatched-a"
                  className="flex h-6 w-full items-center gap-2 rounded group"
                  onClick={() => onSeek(seg.t_start_ms, 'a')}
                >
                  <span className="w-3 shrink-0 text-[10px] text-muted-foreground">A</span>
                  <div className="flex-1 rounded bg-muted relative h-5">
                    <div
                      className="h-full rounded bg-indigo-400/50"
                      style={{ width: pct(dur) }}
                    />
                    <span className="absolute inset-y-0 left-1.5 flex items-center text-[10px]">
                      {formatDuration(dur)}
                    </span>
                  </div>
                </button>
              </div>
            )
          })}

          {unmatched_b.map((seg) => {
            const dur = seg.t_end_ms - seg.t_start_ms
            return (
              <div key={seg.id} className="space-y-1">
                <span className="text-xs text-muted-foreground truncate block">
                  {seg.name}{' '}
                  <span className="italic">B only</span>
                </span>
                <button
                  type="button"
                  data-testid="segment-bar-unmatched-b"
                  className="flex h-6 w-full items-center gap-2 rounded group"
                  onClick={() => onSeek(seg.t_start_ms, 'b')}
                >
                  <span className="w-3 shrink-0 text-[10px] text-muted-foreground">B</span>
                  <div className="flex-1 rounded bg-muted relative h-5">
                    <div
                      className="h-full rounded bg-teal-400/50"
                      style={{ width: pct(dur) }}
                    />
                    <span className="absolute inset-y-0 left-1.5 flex items-center text-[10px]">
                      {formatDuration(dur)}
                    </span>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      )}

      {pairs.length === 0 && unmatched_a.length === 0 && unmatched_b.length === 0 && (
        <p className="text-sm text-muted-foreground">No segments to compare.</p>
      )}
    </div>
  )
}
