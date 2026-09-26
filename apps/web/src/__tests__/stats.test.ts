import { describe, expect, it } from "vitest"

import {
  bootstrapMedianDifference,
  compareGroups,
  median,
  splitByReferenceFingerprint,
} from "@/lib/stats"

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe("bootstrapMedianDifference", () => {
  const a = [60, 62, 58, 65, 61, 59, 63]
  const b = [40, 42, 38, 45, 41, 39, 43]

  it("is deterministic for the same data", () => {
    expect(bootstrapMedianDifference(a, b)).toEqual(bootstrapMedianDifference(a, b))
  })

  it("brackets a clear-cut difference and excludes zero", () => {
    const result = bootstrapMedianDifference(a, b)
    expect(result.difference).toBe(-20)
    expect(result.low).toBeLessThanOrEqual(-20)
    expect(result.high).toBeGreaterThanOrEqual(-20)
    expect(result.high).toBeLessThan(0)
  })

  it("includes zero when the groups are the same", () => {
    const result = bootstrapMedianDifference(a, [...a].reverse())
    expect(result.difference).toBe(0)
    expect(result.low).toBeLessThanOrEqual(0)
    expect(result.high).toBeGreaterThanOrEqual(0)
  })
})

describe("compareGroups", () => {
  const values = (base: number) => [base, base + 2, base - 2, base + 1, base - 1, base + 3]

  it("refuses to call it with too few sessions and says how many more", () => {
    const result = compareGroups({ name: "A", values: [50, 52] }, { name: "B", values: values(30) })
    expect(result.verdict.kind).toBe("too_few")
    expect(result.verdict.text).toBe("Too few sessions to call this. Record at least 3 more in A.")
  })

  it("names the easier group with its interval", () => {
    const result = compareGroups({ name: "A", values: values(60) }, { name: "B", values: values(40) })
    expect(result.verdict.kind).toBe("lower")
    expect(result.verdict.text).toMatch(/^B takes less effort than A: median 20 lower \(95% range -?\d/)
    expect(result.a.n).toBe(6)
  })

  it("reports no clear difference when the interval spans zero", () => {
    const result = compareGroups(
      { name: "A", values: [40, 60, 50, 45, 55, 52] },
      { name: "B", values: [42, 58, 49, 47, 53, 51] }
    )
    expect(result.verdict.kind).toBe("no_difference")
    expect(result.verdict.text).toMatch(/includes zero/)
  })
})

describe("splitByReferenceFingerprint", () => {
  const session = (total: number | null, hash: string | null, at: string) => ({
    analysis: total === null ? null : { total, fingerprint_hash: hash, created_at: at },
  })

  it("keeps sessions on the newest analysis's definition and counts the rest", () => {
    const sessions = [
      session(30, "old", "2026-09-01T00:00:00Z"),
      session(40, "new", "2026-09-26T00:00:00Z"),
      session(45, "new", "2026-09-20T00:00:00Z"),
      session(null, null, "2026-09-26T00:00:00Z"),
    ]
    const { reference, included, excluded } = splitByReferenceFingerprint(sessions)
    expect(reference).toBe("new")
    expect(included.map((s) => s.analysis!.total)).toEqual([40, 45])
    expect(excluded).toBe(1)
  })

  it("never uses an unrecorded definition as the reference, even when it is the newest", () => {
    const sessions = [
      session(40, "fp", "2026-09-20T00:00:00Z"),
      session(30, null, "2026-09-26T00:00:00Z"),
      session(35, null, "2026-09-25T00:00:00Z"),
    ]
    const { reference, included, excluded } = splitByReferenceFingerprint(sessions)
    expect(reference).toBe("fp")
    expect(included).toHaveLength(1)
    expect(excluded).toBe(2)
    const legacyOnly = splitByReferenceFingerprint(sessions.slice(1))
    expect(legacyOnly).toMatchObject({ reference: null, included: [], excluded: 2 })
  })
})
