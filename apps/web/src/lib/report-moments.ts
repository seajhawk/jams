import type { ReportMeasure, ReportPayload } from "@/lib/report-contract"

export type MomentKind = "negative" | "positive" | "switch" | "segment"

export interface Moment {
  id: string
  kind: MomentKind
  /** Where the moment happens in the recording. */
  tMs: number
  title: string
  /** What was said (or what changed) at that moment. */
  detail: string | null
  /** Signed sentiment score for sentiment moments, so the UI can show how strong it was. */
  score: number | null
}

/** When two moments share a timestamp, a segment start reads before the switch and speech at that point. */
const KIND_ORDER: Record<MomentKind, number> = { segment: 0, switch: 1, negative: 2, positive: 2 }

/** Sentiment at or below this is worth a reviewer's attention; at or below FRUSTRATED we call it frustration. */
export const NEGATIVE_THRESHOLD = -0.3
export const FRUSTRATED_THRESHOLD = -0.5
export const POSITIVE_THRESHOLD = 0.5

/** How far before a moment playback starts, so the reviewer hears what led up to it. */
export const LEAD_IN_MS = 1500

export function playbackStartMs(tMs: number): number {
  return Math.max(0, tMs - LEAD_IN_MS)
}

function utteranceFor(sentiment: ReportMeasure, utterances: ReportMeasure[]): ReportMeasure | undefined {
  const linkedId = (sentiment.payload as { utterance_measure_id?: unknown }).utterance_measure_id
  if (typeof linkedId === "string") {
    const linked = utterances.find((u) => u.id === linkedId)
    if (linked) return linked
  }
  const end = sentiment.t_end_ms ?? sentiment.t_start_ms
  return utterances.find((u) => u.t_start_ms < end && (u.t_end_ms ?? u.t_start_ms) > sentiment.t_start_ms)
}

function switchTitle(m: ReportMeasure): string {
  const { from, to } = m.payload as { from: string | null; to: string | null }
  if (from && to) return `Switched from ${from} to ${to}`
  if (to) return `Switched to ${to}`
  return "Switched context"
}

/**
 * The moments in a recording a reviewer most likely wants to jump to and hear or watch:
 * strongly negative or positive speech, context switches, and where each segment begins.
 */
export function buildMoments(payload: ReportPayload): Moment[] {
  const utterances = payload.measures.filter((m) => m.kind === "utterance")
  const moments: Moment[] = []

  for (const m of payload.measures) {
    if (m.kind === "sentiment") {
      const value = m.value_num ?? 0
      if (value > NEGATIVE_THRESHOLD && value < POSITIVE_THRESHOLD) continue
      const quote = utteranceFor(m, utterances)?.value_text ?? null
      const negative = value <= NEGATIVE_THRESHOLD
      moments.push({
        id: m.id,
        kind: negative ? "negative" : "positive",
        tMs: m.t_start_ms,
        title: negative ? (value <= FRUSTRATED_THRESHOLD ? "Frustrated" : "Negative") : "Positive",
        detail: quote,
        score: value,
      })
    } else if (m.kind === "context_switch") {
      moments.push({
        id: m.id,
        kind: "switch",
        tMs: m.t_start_ms,
        title: switchTitle(m),
        detail: null,
        score: null,
      })
    }
  }

  for (const s of payload.segments) {
    if (s.parent_segment_id !== null) continue
    moments.push({
      id: `segment-${s.id}`,
      kind: "segment",
      tMs: s.t_start_ms,
      title: s.name,
      detail: null,
      score: null,
    })
  }

  return moments.sort((a, b) => a.tMs - b.tMs || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id))
}

/** The moment the playhead is currently inside or has most recently passed, for highlighting. */
export function activeMomentId(moments: Moment[], currentTimeMs: number): string | null {
  let active: Moment | undefined
  for (const m of moments) {
    if (m.tMs <= currentTimeMs) active = m
    else break
  }
  return active?.id ?? null
}
