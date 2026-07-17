'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaPlayerInstance } from '@vidstack/react'
import { Toaster } from '@/components/ui/sonner'
import type { ReportPayload } from '@/lib/report-contract'
import type { ComparisonResult } from '@/lib/compare'
import { VideoPlayer } from '@/components/report/VideoPlayer'
import { cn } from '@/lib/utils'
import { DeltaChip } from './DeltaChip'
import { RunCard } from './RunCard'
import { SegmentBars } from './SegmentBars'
import { KindDeltaTable } from './KindDeltaTable'

interface CompareShellProps {
  a: ReportPayload
  b: ReportPayload
  comparison: ComparisonResult
  taskName: string
}

export function CompareShell({
  a,
  b,
  comparison,
  taskName,
}: CompareShellProps) {
  const [activeTab, setActiveTab] = useState<'a' | 'b'>('a')
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const playerRefA = useRef<MediaPlayerInstance | null>(null)
  const playerRefB = useRef<MediaPlayerInstance | null>(null)

  // Pending seek: when switching tabs, record the target so we can apply it
  // after the newly-active player has loaded
  const pendingSeekRef = useRef<number | null>(null)

  useEffect(() => {
    const ms = pendingSeekRef.current
    if (ms === null) return
    pendingSeekRef.current = null
    const ref = activeTab === 'a' ? playerRefA : playerRefB
    const t = setTimeout(() => {
      if (ref.current) ref.current.currentTime = ms / 1000
      setCurrentTimeMs(ms)
    }, 100)
    return () => clearTimeout(t)
  }, [activeTab])

  const seekInRun = useCallback(
    (ms: number, run: 'a' | 'b') => {
      if (run !== activeTab) {
        pendingSeekRef.current = ms
        setActiveTab(run)
      } else {
        const ref = run === 'a' ? playerRefA : playerRefB
        if (ref.current) ref.current.currentTime = ms / 1000
        setCurrentTimeMs(ms)
      }
    },
    [activeTab],
  )

  return (
    <div className="min-h-screen bg-background">
      <Toaster />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b px-4 py-4">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">{taskName}</h1>
            {comparison.score.total !== 0 && (
              <DeltaChip
                delta={comparison.score.total}
                label="Total"
                data-testid="delta-chip-header-total"
              />
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Run A — Baseline
              </p>
              <RunCard
                payload={a}
                labels={comparison.labels_a}
                isBaseline
                dialTestId="compare-dial-a"
              />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Run B — Comparison
              </p>
              <RunCard
                payload={b}
                labels={comparison.labels_b}
                scoreDeltas={comparison.score}
                dialTestId="compare-dial-b"
              />
            </div>
          </div>
        </div>
      </header>

      {/* ── Player with A/B tab switcher ───────────────────────────────────── */}
      <div className="border-b bg-background">
        <div className="mx-auto max-w-4xl">
          {/* Tab buttons */}
          <div className="flex items-center gap-1 border-b px-2 pt-2">
            <button
              type="button"
                role="tab"
                data-testid="compare-tab-a"
                aria-selected={activeTab === 'a'}
                onClick={() => setActiveTab('a')}
                className={cn(
                  'rounded-t-md px-4 py-1.5 text-sm font-medium transition-colors',
                  activeTab === 'a'
                    ? 'bg-background text-foreground border border-b-background -mb-px'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                A — {a.video.title.length > 24 ? a.video.title.slice(0, 24) + '…' : a.video.title}
              </button>
              <button
                type="button"
                role="tab"
                data-testid="compare-tab-b"
                aria-selected={activeTab === 'b'}
                onClick={() => setActiveTab('b')}
                className={cn(
                  'rounded-t-md px-4 py-1.5 text-sm font-medium transition-colors',
                  activeTab === 'b'
                    ? 'bg-background text-foreground border border-b-background -mb-px'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                B — {b.video.title.length > 24 ? b.video.title.slice(0, 24) + '…' : b.video.title}
              </button>
          </div>

          {/* Players — both always mounted; one hidden via CSS */}
          <div className={activeTab === 'a' ? 'block' : 'hidden'}>
            <VideoPlayer
              src={a.video.playback_url}
              playerRef={playerRefA}
              onTimeUpdate={(ms) => {
                if (activeTab === 'a') setCurrentTimeMs(ms)
              }}
            />
          </div>
          <div className={activeTab === 'b' ? 'block' : 'hidden'}>
            <VideoPlayer
              src={b.video.playback_url}
              playerRef={playerRefB}
              onTimeUpdate={(ms) => {
                if (activeTab === 'b') setCurrentTimeMs(ms)
              }}
            />
          </div>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-6">
        {/* Segment comparison */}
        <section>
          <h2 className="mb-3 text-base font-semibold">Segment comparison</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Click a bar to seek that run&apos;s player (switching tab if needed).
            {currentTimeMs > 0 && (
              <> Active player at {Math.round(currentTimeMs / 1000)}s.</>
            )}
          </p>
          <SegmentBars segments={comparison.segments} onSeek={seekInRun} />
        </section>

        {/* Kind delta table */}
        {comparison.kinds.length > 0 && (
          <section>
            <h2 className="mb-3 text-base font-semibold">Measure deltas</h2>
            <KindDeltaTable kinds={comparison.kinds} />
          </section>
        )}
      </div>
    </div>
  )
}
