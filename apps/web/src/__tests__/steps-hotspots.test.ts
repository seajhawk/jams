import { describe, expect, it } from "vitest"

import { computeHotspots, rankHotspots, type HotspotSession } from "@/lib/hotspots"
import { alignSteps, similarity, stems, validBoundaries } from "@/lib/steps"

const seg = (name: string, from: number, to: number) => ({ name, t_start_ms: from, t_end_ms: to })

describe("stems and similarity", () => {
  it("normalizes words so 'Configuring settings' matches 'Configure the setting'", () => {
    expect(similarity(stems("Configuring settings"), stems("Configure the setting"))).toBeGreaterThan(0.4)
    expect(similarity(stems("Sign in"), stems("Pick a plan"))).toBe(0)
    expect([...stems("choosing plans")]).toEqual([...stems("Choose the plan")])
  })
})

describe("alignSteps", () => {
  const steps = ["Sign in", "Choose a plan", "Configure settings"]
  const segments = [
    seg("Signing in to the portal", 0, 10_000),
    seg("Plan options", 10_000, 25_000),
    seg("Choosing the plan", 25_000, 31_000),
    seg("Configuring settings", 31_000, 50_000),
    seg("More settings", 50_000, 60_000),
  ]

  it("uses valid manual boundaries first", () => {
    const result = alignSteps({ steps, segments, durationMs: 60_000, manualBoundariesMs: [5_000, 20_000] })
    expect(result.source).toBe("manual")
    expect(result.steps.map((s) => [s.t_start_ms, s.t_end_ms])).toEqual([
      [0, 5_000],
      [5_000, 20_000],
      [20_000, 60_000],
    ])
  })

  it("matches steps to runs of segments by name and covers the whole session", () => {
    const result = alignSteps({ steps, segments, durationMs: 60_000, manualBoundariesMs: [1, 2, 3] })
    expect(result.source).toBe("matched")
    expect(result.steps.map((s) => [s.t_start_ms, s.t_end_ms])).toEqual([
      [0, 10_000],
      [10_000, 31_000],
      [31_000, 60_000],
    ])
  })

  it("falls back to an even split when a step matches nothing or there are too few segments", () => {
    const unmatched = alignSteps({ steps: ["Sign in", "Pay the invoice"], segments, durationMs: 60_000 })
    expect(unmatched.source).toBe("even")
    expect(unmatched.steps.map((s) => s.t_end_ms)).toEqual([30_000, 60_000])
    expect(alignSteps({ steps, segments: segments.slice(0, 2), durationMs: 60_000 }).source).toBe("even")
  })

  it("is deterministic", () => {
    const input = { steps, segments, durationMs: 60_000 }
    expect(alignSteps(input)).toEqual(alignSteps(input))
  })
})

describe("validBoundaries", () => {
  it("requires m-1 strictly increasing cuts inside the session", () => {
    expect(validBoundaries([10, 20], 3, 30)).toBe(true)
    expect(validBoundaries([20, 10], 3, 30)).toBe(false)
    expect(validBoundaries([10, 30], 3, 30)).toBe(false)
    expect(validBoundaries([10], 3, 30)).toBe(false)
  })
})

describe("computeHotspots", () => {
  const steps = ["Sign in", "Configure settings"]
  const session = (id: string, measures: HotspotSession["measures"]): HotspotSession => ({
    video_id: id,
    run_id: `run-${id}`,
    title: id,
    participant_label: null,
    alignment: {
      source: "manual",
      steps: [
        { step: "Sign in", t_start_ms: 0, t_end_ms: 10_000 },
        { step: "Configure settings", t_start_ms: 10_000, t_end_ms: 40_000 },
      ],
    },
    measures,
  })

  it("counts frustrated sessions per step and keeps each session's worst moment", () => {
    const hotspots = computeHotspots(steps, [
      session("a", [
        { kind: "sentiment", t_start_ms: 15_000, value_num: -0.6, text: "hmm" },
        { kind: "sentiment", t_start_ms: 20_000, value_num: -0.9, text: "why is this failing" },
        { kind: "context_switch", t_start_ms: 12_000, value_num: null },
      ]),
      session("b", [{ kind: "sentiment", t_start_ms: 5_000, value_num: -0.4, text: "okay" }]),
      session("c", [{ kind: "sentiment", t_start_ms: 30_000, value_num: -0.7, text: "ugh" }]),
    ])
    expect(hotspots[0]).toMatchObject({ step: "Sign in", sessions: 3, frustrated_sessions: 0 })
    expect(hotspots[1]).toMatchObject({
      step: "Configure settings",
      sessions: 3,
      frustrated_sessions: 2,
      mean_duration_ms: 30_000,
      mean_switches: 0.3,
    })
    expect(hotspots[1].evidence.map((e) => [e.video_id, e.t_ms, e.text])).toEqual([
      ["a", 20_000, "why is this failing"],
      ["c", 30_000, "ugh"],
    ])
    expect(rankHotspots(hotspots)[0].step).toBe("Configure settings")
  })
})
