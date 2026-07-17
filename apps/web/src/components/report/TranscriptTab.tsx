'use client'

import { useRef, useState, useEffect } from 'react'
import type { ReportPayload, ReportMeasure } from '@/lib/report-contract'
import { formatMs } from '@/lib/format-ms'

function findSentiment(utterance: ReportMeasure, sentimentMeasures: ReportMeasure[]) {
  return (
    sentimentMeasures.find(
      s =>
        s.t_start_ms <= utterance.t_start_ms &&
        (s.t_end_ms ?? s.t_start_ms) >= (utterance.t_end_ms ?? utterance.t_start_ms)
    ) ??
    sentimentMeasures.find(
      s =>
        s.t_start_ms < (utterance.t_end_ms ?? utterance.t_start_ms) &&
        (s.t_end_ms ?? s.t_start_ms) > utterance.t_start_ms
    )
  )
}

function sentimentBorder(val: number | null | undefined): string {
  if (val == null) return 'border-amber-400'
  if (val > 0.15) return 'border-green-400'
  if (val < -0.15) return 'border-red-400'
  return 'border-amber-400'
}

interface TranscriptTabProps {
  payload: ReportPayload
  currentTimeMs: number
  onSeek: (ms: number) => void
}

export function TranscriptTab({ payload, currentTimeMs, onSeek }: TranscriptTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRowRef = useRef<HTMLDivElement>(null)
  const [userScrolled, setUserScrolled] = useState(false)

  const utterances = payload.measures.filter(m => m.kind === 'utterance')
  const sorted = [...utterances].sort((a, b) => a.t_start_ms - b.t_start_ms)
  const sentimentMeasures = payload.measures.filter(m => m.kind === 'sentiment')

  useEffect(() => {
    if (!userScrolled && activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [currentTimeMs, userScrolled])

  return (
    <div className="relative">
      {userScrolled && (
        <button
          className="absolute top-2 right-2 z-10 text-xs bg-muted px-2 py-1 rounded shadow"
          onClick={() => setUserScrolled(false)}
        >
          Resume auto-scroll ↓
        </button>
      )}
      <div
        ref={containerRef}
        className="overflow-y-auto max-h-96 divide-y"
        onScroll={() => setUserScrolled(true)}
      >
        {sorted.map(utterance => {
          const sentiment = findSentiment(utterance, sentimentMeasures)
          const sentimentVal = sentiment?.value_num
          const isActive =
            utterance.t_start_ms <= currentTimeMs &&
            (utterance.t_end_ms ?? 0) > currentTimeMs
          return (
            <div
              key={utterance.id}
              ref={isActive ? activeRowRef : undefined}
              className={`flex items-start gap-3 px-3 py-2 cursor-pointer border-l-[3px] ${sentimentBorder(sentimentVal)} ${isActive ? 'bg-muted' : 'hover:bg-muted/50'}`}
              onClick={() => onSeek(utterance.t_start_ms)}
            >
              <span className="text-muted-foreground text-xs shrink-0 mt-0.5 font-mono">
                {formatMs(utterance.t_start_ms)}
              </span>
              <span className="text-sm">{utterance.value_text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
