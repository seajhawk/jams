'use client'

import { useRef, useState, useLayoutEffect } from 'react'
import type { ReportPayload } from '@/lib/report-contract'
import { formatMs } from '@/lib/format-ms'

const SEGMENT_COLORS = [
  'rgba(99,102,241,0.25)',
  'rgba(20,184,166,0.25)',
  'rgba(245,158,11,0.25)',
  'rgba(239,68,68,0.25)',
]

const SVG_HEIGHT = 200

function diamond(cx: number, cy: number): string {
  return `${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}`
}

interface TimelineProps {
  payload: ReportPayload
  currentTimeMs: number
  onSeek: (ms: number) => void
}

export function Timeline({ payload, currentTimeMs, onSeek }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [isDragging, setIsDragging] = useState(false)

  useLayoutEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      setWidth(entries[0].contentRect.width)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const duration = payload.video.duration_ms
  const msToX = (ms: number) => (ms / duration) * width

  const topSegments = payload.segments.filter(s => s.parent_segment_id === null)
  const subSegments = payload.segments.filter(s => s.parent_segment_id !== null)
  const sentimentMs = payload.measures.filter(m => m.kind === 'sentiment')
  const contextSwitches = payload.measures.filter(m => m.kind === 'context_switch')

  const sentimentY = (v: number) => 105 - v * 35

  const positiveParts = sentimentMs
    .filter(m => (m.value_num ?? 0) > 0)
    .map(m => {
      const x0 = msToX(m.t_start_ms)
      const x1 = msToX(m.t_end_ms ?? m.t_start_ms)
      const y = sentimentY(m.value_num ?? 0)
      return `M ${x0} 105 L ${x0} ${y} L ${x1} ${y} L ${x1} 105 Z`
    })
    .join(' ')

  const negativeParts = sentimentMs
    .filter(m => (m.value_num ?? 0) < 0)
    .map(m => {
      const x0 = msToX(m.t_start_ms)
      const x1 = msToX(m.t_end_ms ?? m.t_start_ms)
      const y = sentimentY(m.value_num ?? 0)
      return `M ${x0} 105 L ${x0} ${y} L ${x1} ${y} L ${x1} 105 Z`
    })
    .join(' ')

  const currentSegment = topSegments.find(
    s => currentTimeMs >= s.t_start_ms && currentTimeMs < s.t_end_ms
  )

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden select-none bg-background border-b"
      style={{ height: SVG_HEIGHT }}
    >
      <svg
        data-testid="report-timeline"
        width={width}
        height={SVG_HEIGHT}
        onClick={(e) => {
          if (isDragging) return
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left
          onSeek(Math.round((x / width) * duration))
        }}
        onMouseMove={(e) => {
          if (!isDragging) return
          const rect = e.currentTarget.getBoundingClientRect()
          const x = Math.max(0, Math.min(width, e.clientX - rect.left))
          onSeek(Math.round((x / width) * duration))
        }}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
        style={{ cursor: isDragging ? 'col-resize' : 'pointer' }}
      >
        {/* Lane 1: Top-level segment bands (y: 10–60) */}
        {topSegments.map((seg, i) => {
          const x = msToX(seg.t_start_ms)
          const w = msToX(seg.t_end_ms) - x
          const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length]
          return (
            <g key={seg.id} onClick={(e) => { e.stopPropagation(); onSeek(seg.t_start_ms) }}>
              <rect x={x} y={10} width={w} height={35} fill={color} rx={4} />
              {w > 40 && (
                <text
                  x={x + 6}
                  y={32}
                  fontSize={11}
                  className="fill-foreground"
                  style={{ userSelect: 'none' }}
                >
                  {seg.name.length * 7 < w
                    ? seg.name
                    : seg.name.slice(0, Math.floor(w / 7) - 2) + '…'}
                </text>
              )}
            </g>
          )
        })}

        {/* Sub-segments (y: 50–65) */}
        {subSegments.map((seg, i) => {
          const x = msToX(seg.t_start_ms)
          const w = msToX(seg.t_end_ms) - x
          const parentIdx = topSegments.findIndex(ts => ts.id === seg.parent_segment_id)
          const color = SEGMENT_COLORS[(parentIdx >= 0 ? parentIdx : i) % SEGMENT_COLORS.length]
          return (
            <rect key={seg.id} x={x} y={50} width={w} height={15} fill={color} rx={2} opacity={0.8} />
          )
        })}

        {/* Lane 2: Sentiment (y: 70–140) */}
        <line
          x1={0} y1={105} x2={width} y2={105}
          stroke="hsl(var(--muted-foreground))"
          strokeDasharray="4 4"
          strokeOpacity={0.4}
        />
        {positiveParts && <path d={positiveParts} fill="rgba(20,184,166,0.3)" />}
        {negativeParts && <path d={negativeParts} fill="rgba(239,68,68,0.3)" />}

        {/* Lane 3: Context switch diamonds (y: 150–185) */}
        {contextSwitches.map(m => {
          const cx = msToX(m.t_start_ms)
          const pts = diamond(cx, 167)
          const switchPayload = m.payload as { from: string | null; to: string | null }
          const label = switchPayload.from && switchPayload.to
            ? `${switchPayload.from} → ${switchPayload.to}`
            : 'Context switch'
          return (
            <polygon key={m.id} points={pts} fill="rgb(245,158,11)" opacity={0.85}>
              <title>{`${label} @ ${formatMs(m.t_start_ms)}`}</title>
            </polygon>
          )
        })}

        {/* Segment name above playhead */}
        {currentSegment && (
          <text
            x={Math.min(msToX(currentTimeMs) + 4, width - 60)}
            y={8}
            fontSize={11}
            className="fill-foreground"
            style={{ userSelect: 'none' }}
          >
            {currentSegment.name}
          </text>
        )}

        {/* Playhead */}
        <line
          data-testid="timeline-playhead"
          x1={msToX(currentTimeMs)} y1={0}
          x2={msToX(currentTimeMs)} y2={SVG_HEIGHT}
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true) }}
          style={{ cursor: 'col-resize' }}
        />
      </svg>
    </div>
  )
}
