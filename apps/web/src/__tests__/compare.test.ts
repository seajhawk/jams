import { describe, expect, it } from "vitest"
import { computeComparison } from "@/lib/compare"
import type { ReportPayload } from "@/lib/report-contract"

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN_A = "a0000000-0000-4000-8000-000000000001"
const RUN_B = "b0000000-0000-4000-8000-000000000001"
const VIDEO_A = "a0000000-0000-4000-8000-000000000002"
const VIDEO_B = "b0000000-0000-4000-8000-000000000002"
const TASK_ID = "a0000000-0000-4000-8000-000000000003"
const PROFILE_ID = "a0000000-0000-4000-8000-000000000004"
const SEG_A1 = "a0000000-0000-4000-8000-000000000010"
const SEG_A2 = "a0000000-0000-4000-8000-000000000011"
const SEG_B1 = "b0000000-0000-4000-8000-000000000010"
const SEG_B2 = "b0000000-0000-4000-8000-000000000011"
const SEG_B3 = "b0000000-0000-4000-8000-000000000012"

function makePayload(
  overrides: {
    runId?: string
    videoId?: string
    durationMs?: number
    score?: Partial<ReportPayload["score"]>
    segments?: ReportPayload["segments"]
  } = {}
): ReportPayload {
  const {
    runId = RUN_A,
    videoId = VIDEO_A,
    durationMs = 120_000,
    segments = [],
    score: scoreOverride,
  } = overrides

  const defaultScore: ReportPayload["score"] = {
    profile: {
      id: PROFILE_ID,
      name: "Default",
      weights: { context_switch: 3, sentiment: 4, spoken_word: 1, time_segment: 2 },
      normalization: {
        context_switch: "per_minute",
        sentiment: "neg_density",
        spoken_word: "per_minute",
        time_segment: "raw_minutes",
      },
    },
    components: {
      physical: 40,
      cognitive: 60,
      time: 50,
      sentiment: 30,
      speech: 20,
    },
    total: 45,
    breakdown: [
      { kind: "context_switch", raw: 4, normalized: 60, weight: 3, contribution: 18 },
      { kind: "spoken_word", raw: 200, normalized: 40, weight: 1, contribution: 4 },
      { kind: "sentiment", raw: 0.1, normalized: 25, weight: 4, contribution: 10 },
      { kind: "time_segment", raw: 2, normalized: 50, weight: 2, contribution: 10 },
    ],
  }

  return {
    contract_version: 1,
    run: {
      id: runId,
      video_id: videoId,
      status: "succeeded",
      pipeline_version: "test-1.0",
      finished_at: "2026-07-17T12:00:00.000Z",
      warnings: [],
    },
    video: {
      id: videoId,
      title: "Test recording",
      duration_ms: durationMs,
      width: 1920,
      height: 1080,
      has_audio: true,
      playback_url: "https://storage.test/video.mp4?sas",
    },
    task: { id: TASK_ID, name: "Test task" },
    segments,
    score: scoreOverride ? { ...defaultScore, ...scoreOverride } : defaultScore,
    measures: [],
  }
}

function seg(
  id: string,
  name: string,
  t_start_ms: number,
  t_end_ms: number,
): ReportPayload["segments"][number] {
  return {
    id,
    parent_segment_id: null,
    name,
    t_start_ms,
    t_end_ms,
    source: "audio_cue",
  }
}

const labelsA = { subject_label: "Participant 1", variant_label: null }
const labelsB = { subject_label: "Participant 2", variant_label: "Alt flow" }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeComparison", () => {
  describe("score deltas", () => {
    it("computes b − a deltas for all components and total", () => {
      const a = makePayload({
        score: {
          components: { physical: 40, cognitive: 60, time: 50, sentiment: 30, speech: 20 },
          total: 45,
        },
      })
      const b = makePayload({
        runId: RUN_B,
        videoId: VIDEO_B,
        score: {
          components: { physical: 50, cognitive: 45, time: 55, sentiment: 25, speech: 20 },
          total: 47,
        },
      })

      const result = computeComparison(a, b, labelsA, labelsB)

      expect(result.score.components.physical).toBe(10)   // 50 - 40
      expect(result.score.components.cognitive).toBe(-15) // 45 - 60
      expect(result.score.components.time).toBe(5)        // 55 - 50
      expect(result.score.components.sentiment).toBe(-5)  // 25 - 30
      expect(result.score.components.speech).toBe(0)      // 20 - 20
      expect(result.score.total).toBe(2)                  // 47 - 45
    })

    it("positive delta means more effort in B (should render red in UI)", () => {
      const a = makePayload({ score: { total: 30 } })
      const b = makePayload({ runId: RUN_B, videoId: VIDEO_B, score: { total: 70 } })

      const { score } = computeComparison(a, b, labelsA, labelsB)
      expect(score.total).toBeGreaterThan(0)
    })

    it("negative delta means less effort in B (should render green in UI)", () => {
      const a = makePayload({ score: { total: 70 } })
      const b = makePayload({ runId: RUN_B, videoId: VIDEO_B, score: { total: 30 } })

      const { score } = computeComparison(a, b, labelsA, labelsB)
      expect(score.total).toBeLessThan(0)
    })
  })

  describe("kind deltas", () => {
    it("computes normalized_delta = b − a for each kind", () => {
      const a = makePayload()
      const b = makePayload({
        runId: RUN_B,
        videoId: VIDEO_B,
        score: {
          breakdown: [
            { kind: "context_switch", raw: 6, normalized: 80, weight: 3, contribution: 24 },
            { kind: "spoken_word", raw: 180, normalized: 35, weight: 1, contribution: 3.5 },
            { kind: "sentiment", raw: 0.2, normalized: 50, weight: 4, contribution: 20 },
            { kind: "time_segment", raw: 2.5, normalized: 62, weight: 2, contribution: 12.4 },
          ],
        },
      })

      const { kinds } = computeComparison(a, b, labelsA, labelsB)

      const cs = kinds.find((k) => k.kind === "context_switch")!
      expect(cs.normalized_delta).toBe(80 - 60)  // 20
      expect(cs.normalized_a).toBe(60)
      expect(cs.normalized_b).toBe(80)

      const sw = kinds.find((k) => k.kind === "spoken_word")!
      expect(sw.normalized_delta).toBe(35 - 40)  // -5
    })

    it("includes rates for per-minute kinds (switches/min, words/min)", () => {
      // Both runs have 120s duration (2 min)
      const a = makePayload({ durationMs: 120_000 })
      const b = makePayload({ runId: RUN_B, videoId: VIDEO_B, durationMs: 120_000 })

      const { kinds } = computeComparison(a, b, labelsA, labelsB)

      // context_switch: raw=4, durationMin=2 → rate=2.0 switches/min
      const cs = kinds.find((k) => k.kind === "context_switch")!
      expect(cs.rate_a).toBe(2)

      // spoken_word: raw=200, durationMin=2 → rate=100 words/min
      const sw = kinds.find((k) => k.kind === "spoken_word")!
      expect(sw.rate_a).toBe(100)

      // sentiment neg_density: raw=0.1 → rate=0.1 (already a ratio)
      const sent = kinds.find((k) => k.kind === "sentiment")!
      expect(sent.rate_a).toBe(0.1)

      // time_segment: raw=2 → rate=2 minutes
      const ts = kinds.find((k) => k.kind === "time_segment")!
      expect(ts.rate_a).toBe(2)
    })
  })

  describe("segment alignment", () => {
    it("returns 'positional' alignment when segment counts are equal", () => {
      const a = makePayload({
        segments: [
          seg(SEG_A1, "Intro", 0, 30_000),
          seg(SEG_A2, "Main", 30_000, 90_000),
        ],
      })
      const b = makePayload({
        runId: RUN_B,
        videoId: VIDEO_B,
        segments: [
          seg(SEG_B1, "Intro", 0, 25_000),
          seg(SEG_B2, "Main", 25_000, 85_000),
        ],
      })

      const { segments } = computeComparison(a, b, labelsA, labelsB)

      expect(segments.alignment).toBe("positional")
      expect(segments.pairs).toHaveLength(2)
      expect(segments.unmatched_a).toHaveLength(0)
      expect(segments.unmatched_b).toHaveLength(0)
    })

    it("returns 'positional_partial' when B has more segments, with unmatched", () => {
      const a = makePayload({
        segments: [
          seg(SEG_A1, "Intro", 0, 30_000),
          seg(SEG_A2, "Main", 30_000, 90_000),
        ],
      })
      const b = makePayload({
        runId: RUN_B,
        videoId: VIDEO_B,
        segments: [
          seg(SEG_B1, "Intro", 0, 25_000),
          seg(SEG_B2, "Main", 25_000, 85_000),
          seg(SEG_B3, "Wrap-up", 85_000, 110_000),
        ],
      })

      const { segments } = computeComparison(a, b, labelsA, labelsB)

      expect(segments.alignment).toBe("positional_partial")
      expect(segments.pairs).toHaveLength(2)
      expect(segments.unmatched_a).toHaveLength(0)
      expect(segments.unmatched_b).toHaveLength(1)
      expect(segments.unmatched_b[0].id).toBe(SEG_B3)
    })

    it("returns 'positional_partial' when A has more segments, with unmatched A", () => {
      const a = makePayload({
        segments: [
          seg(SEG_A1, "Intro", 0, 30_000),
          seg(SEG_A2, "Main", 30_000, 90_000),
        ],
      })
      const b = makePayload({
        runId: RUN_B,
        videoId: VIDEO_B,
        segments: [
          seg(SEG_B1, "Intro", 0, 25_000),
        ],
      })

      const { segments } = computeComparison(a, b, labelsA, labelsB)

      expect(segments.alignment).toBe("positional_partial")
      expect(segments.pairs).toHaveLength(1)
      expect(segments.unmatched_a).toHaveLength(1)
      expect(segments.unmatched_a[0].id).toBe(SEG_A2)
      expect(segments.unmatched_b).toHaveLength(0)
    })

    it("computes duration_delta_ms for each pair (b_duration − a_duration)", () => {
      const a = makePayload({
        segments: [seg(SEG_A1, "Intro", 0, 30_000)], // 30s
      })
      const b = makePayload({
        runId: RUN_B,
        videoId: VIDEO_B,
        segments: [seg(SEG_B1, "Intro", 0, 25_000)], // 25s
      })

      const { segments } = computeComparison(a, b, labelsA, labelsB)
      expect(segments.pairs[0].duration_delta_ms).toBe(-5_000) // B took 5s less
    })

    it("returns 'positional' with empty pairs and unmatched when both have 0 segments", () => {
      const a = makePayload({ segments: [] })
      const b = makePayload({ runId: RUN_B, videoId: VIDEO_B, segments: [] })

      const { segments } = computeComparison(a, b, labelsA, labelsB)
      expect(segments.alignment).toBe("positional")
      expect(segments.pairs).toHaveLength(0)
    })
  })

  describe("video labels", () => {
    it("surfaces subject_label and variant_label for both runs", () => {
      const a = makePayload()
      const b = makePayload({ runId: RUN_B, videoId: VIDEO_B })

      const { labels_a, labels_b } = computeComparison(a, b, labelsA, labelsB)
      expect(labels_a.subject_label).toBe("Participant 1")
      expect(labels_a.variant_label).toBeNull()
      expect(labels_b.subject_label).toBe("Participant 2")
      expect(labels_b.variant_label).toBe("Alt flow")
    })
  })
})
