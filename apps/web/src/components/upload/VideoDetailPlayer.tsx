"use client"

import { useRef } from "react"
import type { MediaPlayerInstance } from "@vidstack/react"

import { VideoPlayer } from "@/components/report/VideoPlayer"

interface VideoDetailPlayerProps {
  src: string
}

export function VideoDetailPlayer({ src }: VideoDetailPlayerProps) {
  const playerRef = useRef<MediaPlayerInstance | null>(null)
  return (
    <div data-testid="video-detail-player" data-src={src}>
      <VideoPlayer src={src} playerRef={playerRef} onTimeUpdate={() => {}} />
    </div>
  )
}
