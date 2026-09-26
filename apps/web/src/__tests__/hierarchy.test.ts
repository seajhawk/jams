import { describe, expect, it } from "vitest"

import {
  createJourneySchema,
  createParticipantSchema,
  journeyStats,
  summarizeTotals,
  updateJourneySchema,
  type JourneySession,
} from "@/lib/hierarchy"

describe("summarizeTotals", () => {
  it("handles no sessions", () => {
    expect(summarizeTotals([])).toEqual({ n: 0, median: null, p25: null, p75: null })
  })

  it("handles one session", () => {
    expect(summarizeTotals([42])).toEqual({ n: 1, median: 42, p25: 42, p75: 42 })
  })

  it("interpolates quartiles for an even count, regardless of input order", () => {
    expect(summarizeTotals([70, 10, 40, 20])).toEqual({ n: 4, median: 30, p25: 17.5, p75: 47.5 })
  })
})

describe("journeyStats", () => {
  let clock = 0
  const session = (total: number | null, hash: string | null): JourneySession => {
    clock += 1
    return {
      video_id: crypto.randomUUID(),
      title: "s",
      created_at: new Date(clock * 1000).toISOString(),
      participant: null,
      variant: null,
      analysis:
        total === null && hash === null
          ? null
          : { id: "r", status: "succeeded", total, fingerprint_hash: hash, created_at: new Date(clock * 1000).toISOString() },
    }
  }

  it("aggregates one definition and ignores unscored sessions", () => {
    const stats = journeyStats([session(10, "a"), session(30, "a"), session(null, null)])
    expect(stats).toMatchObject({ session_count: 3, n: 2, median: 20, excluded: 0, mixed_definitions: false })
  })

  it("never averages across definitions: only the newest definition's sessions count", () => {
    const stats = journeyStats([session(10, "old"), session(90, "old"), session(30, "new")])
    expect(stats).toMatchObject({ n: 1, median: 30, reference_fingerprint: "new", excluded: 2, mixed_definitions: true })
  })

  it("never treats analyses without a fingerprint as comparable, even with each other", () => {
    expect(journeyStats([session(10, null), session(30, "a")])).toMatchObject({ n: 1, median: 30, excluded: 1 })
    expect(journeyStats([session(10, null), session(30, null)])).toMatchObject({
      n: 0,
      median: null,
      reference_fingerprint: null,
      excluded: 2,
      mixed_definitions: true,
    })
  })
})

describe("schemas", () => {
  it("normalizes cohorts to unique lowercase tags", () => {
    expect(createParticipantSchema.parse({ label: "P07", cohorts: ["Beginner", "beginner", "Admin"] }).cohorts)
      .toEqual(["beginner", "admin"])
  })

  it("accepts journeys with steps and rejects empty updates", () => {
    expect(createJourneySchema.parse({ name: "Deploy from VS Code", steps: ["Sign in", "Pick app"] }).steps)
      .toEqual(["Sign in", "Pick app"])
    expect(updateJourneySchema.safeParse({}).success).toBe(false)
    expect(updateJourneySchema.safeParse({ status: "archived" }).success).toBe(false)
  })
})
