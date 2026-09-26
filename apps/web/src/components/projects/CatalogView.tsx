"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, FolderKanban, Plus, RotateCcw, Route, Sparkles, Target } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LocalTime } from "@/components/ui/local-time"
import { Skeleton } from "@/components/ui/skeleton"

export interface JourneyStats {
  session_count: number
  n: number
  median: number | null
  p25: number | null
  p75: number | null
  /** The scoring definition the numbers use; sessions on any other are excluded, never averaged. */
  reference_fingerprint: string | null
  excluded: number
  fingerprint_count: number
  mixed_definitions: boolean
}

interface CatalogJourney {
  id: string
  name: string
  description: string | null
  status: string
  steps: string[]
  stats: JourneyStats
  last_session_at: string | null
}

interface CatalogGoal {
  id: string
  name: string
  description: string | null
  success_criterion: string | null
  journeys: CatalogJourney[]
}

interface CatalogProject {
  id: string
  name: string
  description: string | null
  goals: CatalogGoal[]
}

interface Catalog {
  projects: CatalogProject[]
  ungrouped_journeys: CatalogJourney[]
}

/** The JAMS dogfooding project from docs/design/customer-journeys-ux.md §1. */
const EXAMPLE = {
  name: "JAMS",
  description: "Our own product, measured with JEM and JAMS.",
  goals: [
    { name: "Get my first recording analyzed", journeys: ["Upload from All sessions", "Upload from the empty state"] },
    { name: "Find where my product hurts", journeys: ["Read a report top-down", "Jump through Highlights"] },
    { name: "Prove a fix worked", journeys: ["Compare two sessions"] },
    { name: "Share what I found", journeys: ["Share a link", "Export CSV"] },
    { name: "Tune what effort means for us", journeys: ["Edit the weight profile"] },
  ],
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload
}

/** Lower is easier. A soft heat scale for the median Effort Score chip. */
function effortTone(median: number | null) {
  if (median === null) return "bg-muted text-muted-foreground"
  if (median < 35) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (median < 65) return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
  return "bg-rose-500/10 text-rose-700 dark:text-rose-300"
}

function InlineCreate({
  label,
  placeholder,
  onCreate,
}: {
  label: string
  placeholder: string
  onCreate: (name: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" className="size-4" />
        {label}
      </Button>
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(name.trim())
      setName("")
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create it")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Input
        autoFocus
        aria-label={placeholder}
        placeholder={placeholder}
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="h-8 w-64"
      />
      <Button type="submit" size="sm" disabled={busy || !name.trim()}>
        Create
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </form>
  )
}

function JourneyRow({ journey }: { journey: CatalogJourney }) {
  const { stats } = journey
  return (
    <Link
      href={`/journeys/${journey.id}`}
      className="flex items-center justify-between gap-4 rounded-md px-3 py-2 hover:bg-muted/60"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Route className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{journey.name}</span>
        {journey.status === "retired" && <Badge variant="outline">Retired</Badge>}
      </span>
      <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        {stats.mixed_definitions && (
          <span title="These sessions were scored with different definitions" className="text-amber-600">
            <AlertTriangle className="size-3.5" />
          </span>
        )}
        <span>
          {stats.session_count} session{stats.session_count === 1 ? "" : "s"}
        </span>
        <span
          className={`rounded px-2 py-0.5 font-medium tabular-nums ${effortTone(stats.median)}`}
          title={stats.n > 0 ? `Median Effort Score over ${stats.n} analyzed sessions` : "No analyzed sessions yet"}
        >
          {stats.median ?? "–"}
        </span>
        <span className="hidden w-24 text-right sm:inline">
          {journey.last_session_at ? <LocalTime value={journey.last_session_at} format="date" /> : "No sessions"}
        </span>
      </span>
    </Link>
  )
}

function CatalogSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3 rounded-lg border bg-card p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  )
}

export function CatalogView({ projectId }: { projectId?: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch("/api/catalog")
      if (!response.ok) throw new Error()
      setCatalog((await response.json()) as Catalog)
    } catch {
      setError("Projects could not be loaded. Check your connection and try again.")
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const createProject = async (name: string) => {
    await postJson("/api/projects", { name })
    await load()
  }
  const createGoal = async (project: string, name: string) => {
    await postJson("/api/goals", { project_id: project, name })
    await load()
  }
  const createJourney = async (goal: string, name: string) => {
    await postJson("/api/tasks", { goal_id: goal, name })
    await load()
  }
  const createExample = async () => {
    setSeeding(true)
    setError(null)
    try {
      const { project } = await postJson<{ project: { id: string } }>("/api/projects", {
        name: EXAMPLE.name,
        description: EXAMPLE.description,
      })
      for (const goal of EXAMPLE.goals) {
        const created = await postJson<{ goal: { id: string } }>("/api/goals", {
          project_id: project.id,
          name: goal.name,
        })
        for (const journey of goal.journeys) {
          await postJson("/api/tasks", { goal_id: created.goal.id, name: journey })
        }
      }
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The example could not be created")
    } finally {
      setSeeding(false)
    }
  }

  if (error && !catalog) {
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
  if (!catalog) return <CatalogSkeleton />

  const projects = projectId
    ? catalog.projects.filter((project) => project.id === projectId)
    : catalog.projects

  if (projectId && projects.length === 0) {
    return <p className="text-sm text-muted-foreground">This project does not exist or was removed.</p>
  }

  if (!projectId && projects.length === 0 && catalog.ungrouped_journeys.length === 0) {
    return (
      <div className="flex min-h-[340px] items-center justify-center rounded-lg border border-dashed bg-background p-8 text-center">
        <div className="max-w-lg">
          <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
            <FolderKanban className="size-5 text-muted-foreground" />
          </div>
          <h2 className="mt-5 text-lg font-medium">Organize what you measure</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            A <strong>project</strong> is a product. A <strong>goal</strong> is a job people use it
            for, like &ldquo;get my code running in the cloud&rdquo;. A <strong>journey</strong> is
            one way to reach that goal. Record sessions of each journey, and JAMS tells you which
            way is easiest and where people struggle.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button onClick={createExample} disabled={seeding}>
              <Sparkles data-icon="inline-start" className="size-4" />
              {seeding ? "Creating the example…" : "Start from an example"}
            </Button>
            <InlineCreate label="Start blank" placeholder="Project name" onCreate={createProject} />
          </div>
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {projects.map((project) => (
        <section key={project.id} className="rounded-lg border bg-card">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b p-5">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">
                {projectId ? (
                  project.name
                ) : (
                  <Link href={`/projects/${project.id}`} className="hover:underline">
                    {project.name}
                  </Link>
                )}
              </h2>
              {project.description && (
                <p className="mt-0.5 text-sm text-muted-foreground">{project.description}</p>
              )}
            </div>
            <InlineCreate
              label="Add goal"
              placeholder="A job people get done, e.g. Deploy my app"
              onCreate={(name) => createGoal(project.id, name)}
            />
          </header>
          {project.goals.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">
              No goals yet. Add the jobs people use {project.name} for.
            </p>
          ) : (
            <ul className="divide-y">
              {project.goals.map((goal) => (
                <li key={goal.id} className="p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-medium">
                      <Target className="size-4 text-muted-foreground" />
                      {goal.name}
                    </h3>
                    <InlineCreate
                      label="Add journey"
                      placeholder="One way to do it, e.g. From VS Code"
                      onCreate={(name) => createJourney(goal.id, name)}
                    />
                  </div>
                  {goal.journeys.length === 0 ? (
                    <p className="px-3 text-xs text-muted-foreground">
                      No journeys yet. Add each way people reach this goal.
                    </p>
                  ) : (
                    <div className="space-y-0.5">
                      {goal.journeys.map((journey) => (
                        <JourneyRow key={journey.id} journey={journey} />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {!projectId && catalog.ungrouped_journeys.length > 0 && (
        <section className="rounded-lg border border-dashed bg-card p-5">
          <h2 className="text-sm font-medium">Journeys without a goal</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Created before projects existed, or from an older client.
          </p>
          {catalog.ungrouped_journeys.map((journey) => (
            <JourneyRow key={journey.id} journey={journey} />
          ))}
        </section>
      )}

      {!projectId && (
        <InlineCreate label="New project" placeholder="Project name" onCreate={createProject} />
      )}
    </div>
  )
}
