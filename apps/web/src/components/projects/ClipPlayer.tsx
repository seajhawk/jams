"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { EvidenceMoment } from "@/lib/hotspots"

const LEAD_MS = 1500
const TAIL_MS = 6000

/** Plays each moment back to back: 1.5 s before it to 6 s after, then the next session's. */
export function ClipPlayer({
  title,
  moments,
  onClose,
}: {
  title: string
  moments: EvidenceMoment[]
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const moment = moments[index]

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSrc(null)
    setError(null)
    fetch(`/api/videos/${moment.video_id}/playback-sas`)
      .then(async (response) => {
        if (!response.ok) throw new Error("This session's video is not available")
        return ((await response.json()) as { video: { url: string } }).video.url
      })
      .then((url) => !cancelled && setSrc(url))
      .catch((caught: Error) => !cancelled && setError(caught.message))
    return () => {
      cancelled = true
    }
  }, [moment.video_id])

  const startAt = Math.max(0, moment.t_ms - LEAD_MS) / 1000
  const stopAt = (moment.t_ms + TAIL_MS) / 1000
  const next = () => setIndex((i) => Math.min(moments.length - 1, i + 1))

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="clip-player">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">
            Clip {index + 1} of {moments.length} · {moment.title}
            {moment.participant_label ? ` · ${moment.participant_label}` : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close clips">
          <X className="size-4" />
        </Button>
      </div>
      {error ? (
        <p className="py-8 text-center text-sm text-destructive">{error}</p>
      ) : (
        <video
          key={`${moment.video_id}-${moment.t_ms}`}
          ref={videoRef}
          src={src ?? undefined}
          controls
          autoPlay
          muted={false}
          className="aspect-video w-full rounded-md bg-black"
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = startAt
          }}
          onTimeUpdate={(event) => {
            if (event.currentTarget.currentTime >= stopAt && index < moments.length - 1) next()
            else if (event.currentTarget.currentTime >= stopAt) event.currentTarget.pause()
          }}
        />
      )}
      {moment.text && <p className="mt-3 text-sm italic">&ldquo;{moment.text}&rdquo;</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
            <ChevronLeft data-icon="inline-start" className="size-4" />
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={index === moments.length - 1} onClick={next}>
            Next
            <ChevronRight data-icon="inline-end" className="size-4" />
          </Button>
        </div>
        <Button size="sm" variant="ghost" nativeButton={false} render={<Link href={`/reports/${moment.run_id}?t=${moment.t_ms}`} />}>
          Open in report
        </Button>
      </div>
    </div>
  )
}
