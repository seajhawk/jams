import { describe, expect, it } from "vitest"

import { NEGATIVE_SENTIMENT_THRESHOLD, normalize } from "@/lib/effort-score"
import { NEGATIVE_THRESHOLD } from "@/lib/report-moments"
import type { ReportMeasure, ReportVideo } from "@/lib/report-contract"

describe("negative sentiment density", () => {
  it("counts only utterances at or below the report's attention line", () => {
    // Shared with worker/tests/test_effort_score.py: both scorers must agree.
    const values = [-0.2, -0.29, -0.3, 0, 0, 0, 0, 0, 0, 0]
    const measures = values.map((value, i) => ({
      kind: "sentiment",
      t_start_ms: i * 1000,
      t_end_ms: i * 1000 + 1000,
      value_num: value,
    })) as unknown as ReportMeasure[]
    const video = { duration_ms: 10_000 } as unknown as ReportVideo

    const result = normalize(measures, video, { sentiment: "neg_density" })

    expect(result.sentiment).toMatchObject({ raw: 0.1, normalized: 25 })
  })

  it("uses one threshold for the score and the report", () => {
    expect(NEGATIVE_THRESHOLD).toBe(NEGATIVE_SENTIMENT_THRESHOLD)
  })
})
