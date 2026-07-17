'use client'

import { useRef } from 'react'
import { MediaPlayer, MediaProvider, type MediaPlayerInstance, type MediaTimeUpdateEventDetail } from '@vidstack/react'
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default'
import '@vidstack/react/player/styles/base.css'
import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'

interface VideoPlayerProps {
  src: string
  playerRef: React.RefObject<MediaPlayerInstance | null>
  onTimeUpdate: (ms: number) => void
}

export function VideoPlayer({ src, playerRef, onTimeUpdate }: VideoPlayerProps) {
  const lastUpdateRef = useRef(0)

  return (
    <div className="w-full max-w-4xl mx-auto aspect-video">
      <MediaPlayer
        ref={playerRef}
        src={src}
        onTimeUpdate={(detail: MediaTimeUpdateEventDetail) => {
          const now = Date.now()
          if (now - lastUpdateRef.current < 250) return
          lastUpdateRef.current = now
          onTimeUpdate(Math.round(detail.currentTime * 1000))
        }}
        className="w-full h-full"
      >
        <MediaProvider />
        <DefaultVideoLayout icons={defaultLayoutIcons} />
      </MediaPlayer>
    </div>
  )
}
