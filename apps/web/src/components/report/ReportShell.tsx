'use client'

import { useRef, useState, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { MediaPlayerInstance } from '@vidstack/react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import type { ReportPayload, MeasureKind } from '@/lib/report-contract'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { ReportHeader } from './ReportHeader'
import { VideoPlayer } from './VideoPlayer'
import { Timeline } from './Timeline'
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

export function ReportShell({ payload }: { payload: ReportPayload }) {
  const mounted = useIsMounted()
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [weights, setWeights] = useState<Partial<Record<MeasureKind, number>>>(
    payload.score.profile.weights
  )
  const playerRef = useRef<MediaPlayerInstance | null>(null)

  const seekTo = useCallback((ms: number) => {
    if (playerRef.current) {
      playerRef.current.currentTime = ms / 1000
    }
  }, [])

  useEffect(() => {
    toast.info('Demo report — upload your own video soon')
  }, [])

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
      <ReportHeader payload={payload} weights={weights} currentTimeMs={currentTimeMs} />
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
      />
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Tabs defaultValue="transcript">
          <TabsList>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="measures">Measures</TabsTrigger>
            <TabsTrigger value="score">Score</TabsTrigger>
          </TabsList>
          <TabsContent value="transcript">
            <TranscriptTab payload={payload} currentTimeMs={currentTimeMs} onSeek={seekTo} />
          </TabsContent>
          <TabsContent value="measures">
            <MeasuresTab payload={payload} onSeek={seekTo} />
          </TabsContent>
          <TabsContent value="score">
            <ScoreTab payload={payload} weights={weights} onWeightsChange={setWeights} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
