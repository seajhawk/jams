import { describe, expect, it } from "vitest"

import { findingChanged, findingRedefined, type FindingSnapshot } from "@/lib/findings"

const snapshot = (key: string, reference_fingerprint: string | null): FindingSnapshot => ({
  label: "Checkout: Configure settings",
  headline: "Configure settings: frustration in 2 of 3 sessions.",
  key,
  reference_fingerprint,
  details: {},
  computed_at: new Date(0).toISOString(),
})

describe("finding status", () => {
  it("a hotspot claim holds while the step still shows frustration, whatever its rank", () => {
    expect(findingChanged(snapshot("struggle", "fp1"), snapshot("struggle", "fp1"))).toBe(false)
    expect(findingChanged(snapshot("struggle", "fp1"), snapshot("no-struggle", "fp1"))).toBe(true)
  })

  it("is changed when the source is gone", () => {
    expect(findingChanged(snapshot("struggle", "fp1"), null)).toBe(true)
  })

  it("flags a recomputation under a different scoring definition without calling it changed", () => {
    const saved = snapshot("struggle", "fp1")
    const live = snapshot("struggle", "fp2")
    expect(findingChanged(saved, live)).toBe(false)
    expect(findingRedefined(saved, live)).toBe(true)
  })

  it("does not call unrecorded fingerprints a redefinition", () => {
    expect(findingRedefined(snapshot("lower", null), snapshot("lower", "fp2"))).toBe(false)
    expect(findingRedefined(snapshot("lower", "fp1"), null)).toBe(false)
  })
})
