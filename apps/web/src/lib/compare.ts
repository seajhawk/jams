import type { ReportPayload } from "./report-contract"

export interface ScoreDeltas {
  components: {
    physical: number
    cognitive: number
    time: number
    sentiment: number
    speech: number
  }
  total: number
}

export interface KindDelta {
  kind: string
  /** 0-100 normalized score for run A */
  normalized_a: number
  /** 0-100 normalized score for run B */
  normalized_b: number
  /** b − a; positive = more effort in B */
  normalized_delta: number
  raw_a: number
  raw_b: number
  /** switches/min, words/min, neg_density ratio, or minutes */
  rate_a: number
  rate_b: number
}

export interface AlignedSegmentPair {
  a_segment: ReportPayload["segments"][number]
  b_segment: ReportPayload["segments"][number]
  /** (b_duration) − (a_duration); positive = B took longer */
  duration_delta_ms: number
}

export interface SegmentAlignment {
  /** "positional" when counts equal; "positional_partial" when counts differ */
  alignment: "positional" | "positional_partial"
  pairs: AlignedSegmentPair[]
  unmatched_a: ReportPayload["segments"]
  unmatched_b: ReportPayload["segments"]
}

export interface VideoLabels {
  subject_label: string | null
  variant_label: string | null
}

export interface ComparisonResult {
  score: ScoreDeltas
  kinds: KindDelta[]
  segments: SegmentAlignment
  labels_a: VideoLabels
  labels_b: VideoLabels
}

/**
 * For per-minute kinds, rate = raw_count / durationMin.
 * For sentiment (neg_density) and time_segment (raw_minutes), rate = raw (already normalised).
 */
function computeRate(kind: string, raw: number, durationMin: number): number {
  switch (kind) {
    case "context_switch":
    case "spoken_word":
    case "utterance":
      return durationMin > 0 ? Math.round((raw / durationMin) * 100) / 100 : 0
    default:
      return raw
  }
}

/**
 * Pure comparison computation.
 *
 * Convention: delta = b − a.
 * Positive delta → B has MORE effort (red in UI).
 * Negative delta → B has LESS effort (green in UI).
 */
export function computeComparison(
  a: ReportPayload,
  b: ReportPayload,
  labelsA: VideoLabels,
  labelsB: VideoLabels,
): ComparisonResult {
  // ── Score deltas (b − a) ──────────────────────────────────────────────────
  const score: ScoreDeltas = {
    components: {
      physical: b.score.components.physical - a.score.components.physical,
      cognitive: b.score.components.cognitive - a.score.components.cognitive,
      time: b.score.components.time - a.score.components.time,
      sentiment: b.score.components.sentiment - a.score.components.sentiment,
      speech: b.score.components.speech - a.score.components.speech,
    },
    total: b.score.total - a.score.total,
  }

  // ── Per-kind deltas from score breakdowns ─────────────────────────────────
  const kindMap = new Map<
    string,
    { a: { normalized: number; raw: number }; b: { normalized: number; raw: number } }
  >()

  for (const bd of a.score.breakdown) {
    kindMap.set(bd.kind, {
      a: { normalized: bd.normalized, raw: bd.raw },
      b: { normalized: 0, raw: 0 },
    })
  }
  for (const bd of b.score.breakdown) {
    const entry = kindMap.get(bd.kind)
    if (entry) {
      entry.b = { normalized: bd.normalized, raw: bd.raw }
    } else {
      kindMap.set(bd.kind, {
        a: { normalized: 0, raw: 0 },
        b: { normalized: bd.normalized, raw: bd.raw },
      })
    }
  }

  const durationMinA = a.video.duration_ms / 60_000
  const durationMinB = b.video.duration_ms / 60_000

  const kinds: KindDelta[] = Array.from(kindMap.entries()).map(
    ([kind, { a: ka, b: kb }]) => ({
      kind,
      normalized_a: ka.normalized,
      normalized_b: kb.normalized,
      normalized_delta: kb.normalized - ka.normalized,
      raw_a: ka.raw,
      raw_b: kb.raw,
      rate_a: computeRate(kind, ka.raw, durationMinA),
      rate_b: computeRate(kind, kb.raw, durationMinB),
    }),
  )

  // ── Positional segment alignment ──────────────────────────────────────────
  const segsA = a.segments
  const segsB = b.segments
  const pairCount = Math.min(segsA.length, segsB.length)

  const pairs: AlignedSegmentPair[] = []
  for (let i = 0; i < pairCount; i++) {
    const sa = segsA[i]
    const sb = segsB[i]
    pairs.push({
      a_segment: sa,
      b_segment: sb,
      duration_delta_ms:
        (sb.t_end_ms - sb.t_start_ms) - (sa.t_end_ms - sa.t_start_ms),
    })
  }

  return {
    score,
    kinds,
    segments: {
      alignment:
        segsA.length !== segsB.length ? "positional_partial" : "positional",
      pairs,
      unmatched_a: segsA.slice(pairCount),
      unmatched_b: segsB.slice(pairCount),
    },
    labels_a: labelsA,
    labels_b: labelsB,
  }
}
