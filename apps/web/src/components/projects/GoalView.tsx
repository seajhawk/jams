"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { RotateCcw, Trophy } from "lucide-react"

import { SaveFindingButton } from "@/components/projects/SaveFindingButton"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { GoalJourneyResult } from "@/lib/comparisons"

interface GoalCompare {
  goal: { id: string; name: string; description: string | null; success_criterion: string | null }
  project: { id: string; name: string } | null
  excluded: number
  easiest_id: string | null
  journeys: GoalJourneyResult[]
}

function Dots({ totals, name }: { totals: number[]; name: string }) {
  const sorted = [...totals].sort((x, y) => x - y)
  return (
    <>
      <svg viewBox="0 0 400 20" className="h-5 w-full" aria-hidden>
        <line x1="10" x2="390" y1="10" y2="10" className="stroke-border" strokeWidth="2" />
        {totals.map((total, index) => (
          <circle key={index} cx={10 + total * 3.8} cy={10 + ((index % 3) - 1) * 3} r="4" fill="#2563eb" fillOpacity="0.7">
            <title>{`Session score ${total}`}</title>
          </circle>
        ))}
      </svg>
      {/* The same scores for screen readers, which the drawing hides. */}
      <span className="sr-only">
        {sorted.length === 0 ? `${name}: no analyzed sessions.` : `${name} session scores: ${sorted.join(", ")}.`}
      </span>
    </>
  )
}

/** A goal's journeys as a leaderboard: which way of getting it done is easiest. */
export function GoalView({ goalId }: { goalId: string }) {
  const [data, setData] = useState<GoalCompare | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch(`/api/goals/${goalId}/compare`)
      if (response.status === 404) throw new Error("This goal does not exist or was removed.")
      if (!response.ok) throw new Error("The goal could not be loaded. Check your connection and try again.")
      setData((await response.json()) as GoalCompare)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The goal could not be loaded.")
    }
  }, [goalId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RotateCcw data-icon="inline-start" className="size-4" />
          Try again
        </Button>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const measured = data.journeys.filter((journey) => journey.stats.n > 0)

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:underline">
          Projects
        </Link>
        {data.project && (
          <>
            <span>›</span>
            <Link href={`/projects/${data.project.id}`} className="hover:underline">
              {data.project.name}
            </Link>
          </>
        )}
      </nav>

      <div>
        <h1 className="text-2xl font-semibold">{data.goal.name}</h1>
        {data.goal.description && <p className="mt-1 text-sm text-muted-foreground">{data.goal.description}</p>}
        {data.goal.success_criterion && (
          <p className="mt-1 text-sm">
            <span className="text-muted-foreground">Success looks like: </span>
            {data.goal.success_criterion}
          </p>
        )}
      </div>

      <section className="rounded-lg border bg-card">
        <header className="border-b px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Which way is easiest?</h2>
            {measured.length > 1 && (
              <SaveFindingButton
                source={{ kind: "leaderboard", goal_id: data.goal.id }}
                defaultTitle={`Easiest way to ${data.goal.name}`}
              />
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Journeys ranked by median Effort Score, each compared with the easiest.
            {data.excluded > 0 &&
              ` ${data.excluded} session${data.excluded === 1 ? " is" : "s are"} left out: scored with an older definition.`}
          </p>
        </header>
        {data.journeys.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            No journeys yet. Add each way people reach this goal from the project page.
          </p>
        ) : (
          <ol className="divide-y">
            {data.journeys.map((journey, index) => (
              <li key={journey.id} data-testid="goal-journey" className="grid gap-2 px-5 py-3 md:grid-cols-[1fr_220px]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-right text-sm tabular-nums text-muted-foreground">
                      {journey.stats.n > 0 ? index + 1 : "–"}
                    </span>
                    <Link href={`/journeys/${journey.id}`} className="truncate font-medium hover:underline">
                      {journey.name}
                    </Link>
                    {journey.id === data.easiest_id && measured.length > 1 && (
                      <Trophy className="size-4 text-amber-500" aria-label="Easiest" />
                    )}
                  </div>
                  <p className="ml-7 mt-0.5 text-xs text-muted-foreground">
                    {journey.stats.n === 0
                      ? "No analyzed sessions yet."
                      : journey.vs_easiest
                        ? journey.vs_easiest.verdict.text
                        : measured.length > 1
                          ? "The easiest way so far."
                          : "The only journey with analyzed sessions so far."}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Dots totals={journey.totals} name={journey.name} />
                  <span className="w-16 shrink-0 text-right text-sm">
                    <span className="font-semibold tabular-nums">{journey.stats.median ?? "–"}</span>
                    <span className="text-xs text-muted-foreground"> n={journey.stats.n}</span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
