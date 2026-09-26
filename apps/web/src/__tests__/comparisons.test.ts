import { describe, expect, it } from "vitest"

import { compareJourneysOfGoal, compareWithinJourney, outdatedSessions } from "@/lib/comparisons"
import type { JourneySession } from "@/lib/hierarchy"

let clock = 0
function session(
  total: number | null,
  options: { variant?: string; cohorts?: string[]; hash?: string | null; status?: string } = {}
): JourneySession {
  clock += 1
  const status = options.status ?? (total === null ? "failed" : "succeeded")
  return {
    video_id: `v${clock}`,
    title: `s${clock}`,
    created_at: new Date(clock * 1000).toISOString(),
    participant: options.cohorts ? { id: `p${clock}`, label: `P${clock}`, cohorts: options.cohorts } : null,
    variant: options.variant ? { id: options.variant, name: options.variant, build: null } : null,
    analysis:
      options.status === "none"
        ? null
        : {
            id: `r${clock}`,
            status,
            total,
            fingerprint_hash: options.hash === undefined ? "fp" : options.hash,
            created_at: new Date(clock * 1000).toISOString(),
          },
  }
}

describe("compareWithinJourney", () => {
  it("compares two variants and says B is easier", () => {
    const sessions = [
      ...[60, 62, 58, 64, 61].map((t) => session(t, { variant: "A" })),
      ...[40, 42, 38, 44, 41].map((t) => session(t, { variant: "B" })),
    ]
    const result = compareWithinJourney(sessions, "variant", "A", "B")
    expect(result.comparison.verdict.kind).toBe("lower")
    expect(result.comparison.difference).toBe(-20)
    expect(result.points.b).toHaveLength(5)
    expect(result.excluded).toBe(0)
  })

  it("groups by cohort tag and excludes other scoring definitions", () => {
    const sessions = [
      session(70, { cohorts: ["beginner"], hash: "old" }),
      session(55, { cohorts: ["beginner"] }),
      session(30, { cohorts: ["expert"] }),
    ]
    const result = compareWithinJourney(sessions, "cohort", "beginner", "expert")
    expect(result.excluded).toBe(1)
    expect(result.comparison.a.n).toBe(1)
    expect(result.comparison.verdict.kind).toBe("too_few")
  })
})

describe("compareJourneysOfGoal", () => {
  it("ranks journeys easiest first and compares each with the easiest", () => {
    const result = compareJourneysOfGoal([
      { id: "portal", name: "Portal", sessions: [55, 60, 58, 62, 57].map((t) => session(t)) },
      { id: "cli", name: "CLI", sessions: [30, 32, 28, 35, 31].map((t) => session(t)) },
      { id: "new", name: "Not recorded yet", sessions: [] },
    ])
    expect(result.journeys.map((j) => j.id)).toEqual(["cli", "portal", "new"])
    expect(result.easiest_id).toBe("cli")
    expect(result.journeys[0].vs_easiest).toBeNull()
    expect(result.journeys[1].vs_easiest?.verdict.kind).toBe("higher")
    expect(result.journeys[2].vs_easiest).toBeNull()
  })
})

describe("outdatedSessions with only legacy analyses", () => {
  it("offers every scored session for re-analysis when no definition was recorded", () => {
    const legacy = [session(40, { hash: null }), session(50, { hash: null })]
    expect(outdatedSessions(legacy)).toHaveLength(2)
  })
})

describe("outdatedSessions", () => {
  it("picks never-analyzed, failed and old-definition sessions, and leaves in-flight ones", () => {
    const old = session(40, { hash: "old" })
    const failed = session(null, { status: "failed" })
    const never = session(null, { status: "none" })
    const running = session(null, { status: "running" })
    const current = session(35, { hash: "new" })
    expect(outdatedSessions([old, failed, never, running, current]).map((s) => s.video_id)).toEqual([
      old.video_id,
      failed.video_id,
      never.video_id,
    ])
  })
})
