import { describe, expect, it } from "vitest"

import { hardestGoal } from "@/components/projects/PortfolioViews"

const journey = (name: string, median: number | null, n = 5) => ({ id: name, name, stats: { n, median } })

describe("hardestGoal", () => {
  it("picks the goal whose easiest journey is still the most effortful", () => {
    const result = hardestGoal({
      id: "p",
      name: "P",
      goals: [
        // Deploy has a hard way (80) but also an easy one (30): not the hardest goal.
        { id: "deploy", name: "Deploy", journeys: [journey("Portal", 80), journey("CLI", 30)] },
        // Scale's best way is 55: people have no easy option here.
        { id: "scale", name: "Scale", journeys: [journey("Manual", 70), journey("Autoscale", 55)] },
        { id: "empty", name: "Unmeasured", journeys: [journey("Nothing yet", null, 0)] },
      ],
    })
    expect(result).toEqual({ id: "scale", name: "Scale", median: 55 })
  })

  it("returns null when nothing has been measured", () => {
    expect(hardestGoal({ id: "p", name: "P", goals: [] })).toBeNull()
  })
})
