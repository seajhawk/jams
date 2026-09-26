"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Bookmark, Flame } from "lucide-react"

interface PortfolioJourney {
  id: string
  name: string
  stats: { n: number; median: number | null }
  recent_session_count?: number
}

export interface PortfolioProject {
  id: string
  name: string
  goals: { id: string; name: string; journeys: PortfolioJourney[] }[]
}

function heat(median: number | null) {
  if (median === null) return "bg-muted text-muted-foreground"
  if (median < 35) return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
  if (median < 65) return "bg-amber-500/15 text-amber-800 dark:text-amber-200"
  return "bg-rose-500/20 text-rose-800 dark:text-rose-200"
}

/** The goal whose easiest journey is still the most effortful: where to spend next. */
export function hardestGoal(project: PortfolioProject) {
  let hardest: { id: string; name: string; median: number } | null = null
  for (const goal of project.goals) {
    const medians = goal.journeys.flatMap((j) => (j.stats.n > 0 && j.stats.median !== null ? [j.stats.median] : []))
    if (medians.length === 0) continue
    const easiest = Math.min(...medians)
    if (!hardest || easiest > hardest.median) hardest = { id: goal.id, name: goal.name, median: easiest }
  }
  return hardest
}

/** One card per project: recent activity, where it hurts most, and the latest saved finding. */
export function WorkspaceSummary({ projects }: { projects: PortfolioProject[] }) {
  const [latest, setLatest] = useState<{ title: string } | null>(null)
  useEffect(() => {
    fetch("/api/findings")
      .then((response) => (response.ok ? response.json() : { findings: [] }))
      .then((body: { findings: { title: string }[] }) => setLatest(body.findings[0] ?? null))
      .catch(() => {})
  }, [])

  if (projects.length === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="workspace-summary">
      {projects.map((project) => {
        const recent = project.goals
          .flatMap((goal) => goal.journeys)
          .reduce((sum, journey) => sum + (journey.recent_session_count ?? 0), 0)
        const hardest = hardestGoal(project)
        return (
          <Link key={project.id} href={`/projects/${project.id}`} className="rounded-lg border bg-card p-4 hover:bg-muted/40">
            <p className="font-medium">{project.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {recent} session{recent === 1 ? "" : "s"} in the last 30 days
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-sm">
              <Flame className="size-3.5 text-rose-500" />
              {hardest ? (
                <span>
                  Hardest: {hardest.name} <span className="text-muted-foreground">(best way {hardest.median})</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Not enough analyzed sessions yet</span>
              )}
            </p>
          </Link>
        )
      })}
      {latest && (
        <Link href="/findings" className="rounded-lg border border-dashed bg-card p-4 hover:bg-muted/40">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Bookmark className="size-3.5" /> Latest finding
          </p>
          <p className="mt-1 text-sm font-medium">{latest.title}</p>
        </Link>
      )}
    </div>
  )
}

/** Goals as rows, their journeys as heat cells: where effort concentrates in this project. */
export function ProjectHeatmap({ project }: { project: PortfolioProject }) {
  const goals = project.goals.filter((goal) => goal.journeys.length > 0)
  if (goals.length === 0) return null
  return (
    <section className="rounded-lg border bg-card p-5" data-testid="project-heatmap">
      <h2 className="mb-3 text-sm font-medium">Where effort concentrates</h2>
      <div className="space-y-2">
        {goals.map((goal) => (
          <div key={goal.id} className="grid items-center gap-2 md:grid-cols-[220px_1fr]">
            <Link href={`/goals/${goal.id}`} className="truncate text-sm hover:underline">
              {goal.name}
            </Link>
            <div className="flex flex-wrap gap-1.5">
              {goal.journeys.map((journey) => (
                <Link
                  key={journey.id}
                  href={`/journeys/${journey.id}`}
                  title={`${journey.name}: median ${journey.stats.median ?? "–"}, n=${journey.stats.n}`}
                  className={`min-w-28 rounded-md px-2.5 py-1.5 text-xs ${heat(journey.stats.median)}`}
                >
                  <span className="block truncate font-medium">{journey.name}</span>
                  <span className="tabular-nums">
                    {journey.stats.median ?? "–"} · n={journey.stats.n}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Median Effort Score per journey. Lower is easier.</p>
    </section>
  )
}
