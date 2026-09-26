'use client'

import { useRef, useState, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { MediaPlayerInstance } from '@vidstack/react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import type { ReportPayload, MeasureKind } from '@/lib/report-contract'
import { playbackStartMs } from '@/lib/report-moments'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { ReportHeader } from './ReportHeader'
import { VideoPlayer } from './VideoPlayer'
import { Timeline } from './Timeline'
import { HighlightsTab } from './HighlightsTab'
import { TranscriptTab } from './TranscriptTab'
import { MeasuresTab } from './MeasuresTab'
import { ScoreTab } from './ScoreTab'

// useSyncExternalStore is the lint-safe way to detect server vs. client rendering
function useIsMounted() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )
}

export function ReportShell({
  payload,
  demo = false,
  readOnly = false,
  initialSeekMs,
}: {
  payload: ReportPayload
  demo?: boolean
  readOnly?: boolean
  /** Deep link (`?t=` in ms): seek here once the media can play. */
  initialSeekMs?: number
}) {
  const mounted = useIsMounted()
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [weights, setWeights] = useState<Partial<Record<MeasureKind, number>>>(
    payload.score.profile.weights
  )
  const playerRef = useRef<MediaPlayerInstance | null>(null)

  const seekTo = useCallback((ms: number) => {
    setCurrentTimeMs(ms)
    if (playerRef.current) {
      playerRef.current.currentTime = ms / 1000
    }
  }, [])

  // Jump to a point in the analysis and start playing it, so the reviewer hears what was said.
  // Scrubbing (timeline drag, arrow keys) uses seekTo and leaves play/pause alone.
  const playFrom = useCallback(
    (ms: number) => {
      seekTo(ms)
      // Playback can be refused (autoplay policy, media not ready); the seek itself still stands.
      void Promise.resolve(playerRef.current?.play()).catch(() => {})
    },
    [seekTo]
  )

  const playMoment = useCallback((tMs: number) => playFrom(playbackStartMs(tMs)), [playFrom])

  useEffect(() => {
    if (demo) toast.info('Demo report — upload your own video soon')
  }, [demo])

  // A deep link lands on its moment however long the media takes to load: wait for the player to
  // mount, then for it to report it can play (setting currentTime earlier is not reliably
  // honoured). No deadline; everything is torn down on unmount.
  useEffect(() => {
    if (initialSeekMs === undefined) return
    let stopWatching: (() => void) | undefined
    let done = false
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (!player) return
      window.clearInterval(timer)
      stopWatching = player.subscribe(({ canPlay }) => {
        if (canPlay && !done) {
          done = true
          seekTo(initialSeekMs)
        }
      })
    }, 100)
    return () => {
      window.clearInterval(timer)
      stopWatching?.()
    }
  }, [initialSeekMs, seekTo])

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === ' ') {
        e.preventDefault()
        if (playerRef.current?.paused) {
          playerRef.current.play()
        } else {
          playerRef.current?.pause()
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seekTo(Math.max(0, currentTimeMs - 5000))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seekTo(Math.min(payload.video.duration_ms, currentTimeMs + 5000))
      } else if (e.key === 's') {
        const nextSegment = payload.segments
          .filter(s => s.t_start_ms > currentTimeMs)
          .sort((a, b) => a.t_start_ms - b.t_start_ms)[0]
        if (nextSegment) seekTo(nextSegment.t_start_ms)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentTimeMs, payload, seekTo])

  if (!mounted) {
    return (
      <div className="min-h-screen bg-background">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="mx-auto mt-2 aspect-video w-full max-w-4xl" />
        <Skeleton className="mt-2 h-[200px] w-full" />
        <div className="mx-auto max-w-6xl px-4 py-6 space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Toaster />
      {readOnly && (
        <div className="flex items-center gap-3 border-b bg-background px-4 py-2">
          <span className="font-semibold tracking-tight">JAMS</span>
          <span className="rounded-md border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Shared report
          </span>
        </div>
      )}
      <ReportHeader
        payload={payload}
        weights={weights}
        currentTimeMs={currentTimeMs}
        demo={demo}
        readOnly={readOnly}
      />
      <div className="sticky top-0 z-30 bg-background shadow-sm">
        <VideoPlayer
          src={payload.video.playback_url}
          playerRef={playerRef}
          onTimeUpdate={setCurrentTimeMs}
        />
      </div>
      <Timeline
        payload={payload}
        currentTimeMs={currentTimeMs}
        onSeek={seekTo}
        onPlayMoment={playMoment}
      />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Tabs defaultValue="highlights">
          <TabsList>
            <TabsTrigger value="highlights">Highlights</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="measures">Measures</TabsTrigger>
            <TabsTrigger value="score">Score</TabsTrigger>
          </TabsList>
          <TabsContent value="highlights">
            <HighlightsTab
              payload={payload}
              currentTimeMs={currentTimeMs}
              onPlayMoment={playMoment}
            />
          </TabsContent>
          <TabsContent value="transcript">
            <TranscriptTab payload={payload} currentTimeMs={currentTimeMs} onSeek={playFrom} />
          </TabsContent>
          <TabsContent value="measures">
            <MeasuresTab payload={payload} onSeek={playFrom} />
          </TabsContent>
          <TabsContent value="score">
            <ScoreTab
              payload={payload}
              weights={weights}
              onWeightsChange={setWeights}
              readOnly={readOnly}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
