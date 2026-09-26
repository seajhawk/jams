"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, GitCompareArrows, RotateCcw, Upload } from "lucide-react"

import type { JourneyStats } from "@/components/projects/CatalogView"
import { ComparePanel } from "@/components/projects/ComparePanel"
import { StepsPanel } from "@/components/projects/StepsPanel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { LocalTime } from "@/components/ui/local-time"
import { Skeleton } from "@/components/ui/skeleton"
import { outdatedSessions } from "@/lib/comparisons"
import type { JourneySession } from "@/lib/hierarchy"
import { summarizeTotals } from "@/lib/stats"

interface JourneySummary {
  journey: { id: string; name: string; description: string | null; steps: string[]; status: string }
  goal: { id: string; name: string; success_criterion: string | null } | null
  project: { id: string; name: string } | null
  stats: JourneyStats
  sessions: JourneySession[]
}

/** Fewer scored sessions than this and the page says so instead of implying a verdict. */
const MIN_SESSIONS_FOR_CONFIDENCE = 5
const VARIANT_COLORS = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed", "#0891b2"]

function StripPlot({ sessions, colorFor }: { sessions: JourneySession[]; colorFor: (s: JourneySession) => string }) {
  const scored = sessions.filter((session) => session.analysis?.total != null)
  return (
    <svg viewBox="0 0 400 56" className="h-14 w-full" role="img" aria-label="Effort Score of each session">
      <line x1="10" x2="390" y1="28" y2="28" className="stroke-border" strokeWidth="2" />
      {[0, 25, 50, 75, 100].map((tick) => (
        <g key={tick}>
          <line x1={10 + tick * 3.8} x2={10 + tick * 3.8} y1="23" y2="33" className="stroke-border" />
          <text x={10 + tick * 3.8} y="50" textAnchor="middle" className="fill-muted-foreground text-[9px]">
            {tick}
          </text>
        </g>
      ))}
      {scored.map((session, index) => (
        <circle
          key={session.video_id}
          cx={10 + (session.analysis!.total as number) * 3.8}
          cy={28 + ((index % 3) - 1) * 6}
          r="5"
          fill={colorFor(session)}
          fillOpacity="0.75"
        >
          <title>{`${session.title}: ${session.analysis!.total}`}</title>
        </circle>
      ))}
    </svg>
  )
}

function FilterChips({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: string[]
  value: string | null
  onChange: (value: string | null) => void
}) {
  if (options.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {[null, ...options].map((option) => (
        <button
          key={option ?? "all"}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`rounded-full border px-2.5 py-0.5 text-xs ${
            value === option ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"
          }`}
        >
          {option ?? "All"}
        </button>
      ))}
    </div>
  )
}

export function JourneyView({ journeyId }: { journeyId: string }) {
  const router = useRouter()
  const [summary, setSummary] = useState<JourneySummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cohort, setCohort] = useState<string | null>(null)
  const [variant, setVariant] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [confirmReanalyze, setConfirmReanalyze] = useState(false)
  const [reanalyzeNote, setReanalyzeNote] = useState<string | null>(null)
  const [reanalyzing, setReanalyzing] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch(`/api/journeys/${journeyId}/summary`)
      if (response.status === 404) throw new Error("This journey does not exist or was removed.")
      if (!response.ok) throw new Error("The journey could not be loaded. Check your connection and try again.")
      setSummary((await response.json()) as JourneySummary)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The journey could not be loaded.")
    }
  }, [journeyId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const cohorts = useMemo(
    () => [...new Set(summary?.sessions.flatMap((s) => s.participant?.cohorts ?? []) ?? [])].sort(),
    [summary]
  )
  const variantNames = useMemo(
    () => [...new Set(summary?.sessions.flatMap((s) => (s.variant ? [s.variant.name] : [])) ?? [])].sort(),
    [summary]
  )
  const visible = useMemo(
    () =>
      (summary?.sessions ?? []).filter(
        (session) =>
          (!cohort || session.participant?.cohorts.includes(cohort)) &&
          (!variant || session.variant?.name === variant)
      ),
    [summary, cohort, variant]
  )
  const stats = useMemo(
    () => summarizeTotals(visible.flatMap((s) => (s.analysis?.total != null ? [s.analysis.total] : []))),
    [visible]
  )
  const colorFor = (session: JourneySession) =>
    session.variant
      ? VARIANT_COLORS[variantNames.indexOf(session.variant.name) % VARIANT_COLORS.length]
      : "#64748b"

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
  if (!summary) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  const outdated = outdatedSessions(summary.sessions)
  const reanalyze = async () => {
    setReanalyzing(true)
    try {
      const response = await fetch(`/api/journeys/${journeyId}/reanalyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ only: "outdated" }),
      })
      const body = (await response.json()) as {
        queued?: unknown[]
        skipped?: { reason: string }[]
        error?: string
      }
      if (!response.ok) throw new Error(body.error ?? "Re-analysis could not be queued")
      const skipped = body.skipped ?? []
      setReanalyzeNote(
        `Queued ${body.queued?.length ?? 0}.` +
          (skipped.length ? ` ${skipped.length} not queued: ${skipped[0].reason}.` : "") +
          " Scores update as each analysis finishes."
      )
      setConfirmReanalyze(false)
      await load()
    } catch (caught) {
      setReanalyzeNote(caught instanceof Error ? caught.message : "Re-analysis could not be queued")
    } finally {
      setReanalyzing(false)
    }
  }

  const togglePick = (runId: string) =>
    setPicked((current) =>
      current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId].slice(-2)
    )

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:underline">
          Projects
        </Link>
        {summary.project && (
          <>
            <span>›</span>
            <Link href={`/projects/${summary.project.id}`} className="hover:underline">
              {summary.project.name}
            </Link>
          </>
        )}
        {summary.goal && (
          <>
            <span>›</span>
            <Link href={`/goals/${summary.goal.id}`} className="hover:underline">
              {summary.goal.name}
            </Link>
          </>
        )}
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{summary.journey.name}</h1>
          {summary.journey.description && (
            <p className="mt-1 text-sm text-muted-foreground">{summary.journey.description}</p>
          )}
          {summary.goal?.success_criterion && (
            <p className="mt-1 text-sm">
              <span className="text-muted-foreground">Success looks like: </span>
              {summary.goal.success_criterion}
            </p>
          )}
        </div>
        <Button nativeButton={false} render={<Link href={`/library?upload=1&journey=${summary.journey.id}`} />}>
          <Upload data-icon="inline-start" className="size-4" />
          Add a session
        </Button>
      </div>

      <section className="grid gap-4 rounded-lg border bg-card p-5 md:grid-cols-[220px_1fr]">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Median Effort Score</p>
          <p className="mt-1 text-4xl font-semibold tabular-nums">{stats.median ?? "–"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {stats.n === 0
              ? "No analyzed sessions yet"
              : `${stats.n} analyzed session${stats.n === 1 ? "" : "s"}` +
                (stats.n > 1 ? ` · middle half ${stats.p25}–${stats.p75}` : "")}
          </p>
          {stats.n > 0 && stats.n < MIN_SESSIONS_FOR_CONFIDENCE && (
            <p className="mt-2 text-xs text-muted-foreground">
              Too few sessions to generalize. Record {MIN_SESSIONS_FOR_CONFIDENCE - stats.n} more
              to trust the pattern.
            </p>
          )}
        </div>
        <div className="flex flex-col justify-center gap-2">
          <StripPlot sessions={visible} colorFor={colorFor} />
          <div className="flex flex-wrap gap-4">
            <FilterChips label="Cohort" options={cohorts} value={cohort} onChange={setCohort} />
            <FilterChips label="Variant" options={variantNames} value={variant} onChange={setVariant} />
          </div>
        </div>
      </section>

      {outdated.length > 0 && (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1 space-y-2">
            <p>
              {summary.stats.mixed_definitions
                ? `These sessions were scored with ${summary.stats.fingerprint_count} different scoring definitions (JAMS's models or formula changed between analyses), so their scores are not directly comparable.`
                : "Some sessions have no current analysis."}{" "}
              {outdated.length} session{outdated.length === 1 ? " needs" : "s need"} analyzing with
              the current definitions.
            </p>
            {reanalyzeNote && <p className="text-muted-foreground">{reanalyzeNote}</p>}
            {confirmReanalyze ? (
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  Queue {outdated.length} analys{outdated.length === 1 ? "is" : "es"}? Each counts
                  toward your analysis quota.
                </span>
                <Button size="sm" disabled={reanalyzing} onClick={reanalyze}>
                  {reanalyzing ? "Queuing…" : "Queue them"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReanalyze(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmReanalyze(true)}>
                Re-analyze {outdated.length} session{outdated.length === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        </div>
      )}

      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 text-sm font-medium">Where people struggle</h2>
        <StepsPanel journeyId={summary.journey.id} cohort={cohort} variant={variant} />
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 text-sm font-medium">Compare</h2>
        <ComparePanel
          key={`${variantNames.join("|")}::${cohorts.join("|")}`}
          journeyId={summary.journey.id}
          variants={variantNames}
          cohorts={cohorts}
        />
      </section>

      <section className="rounded-lg border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
          <h2 className="text-sm font-medium">
            Sessions <span className="text-muted-foreground">({visible.length})</span>
          </h2>
          <Button
            size="sm"
            variant="outline"
            disabled={picked.length !== 2}
            onClick={() => router.push(`/compare?runs=${picked.join(",")}`)}
          >
            <GitCompareArrows data-icon="inline-start" className="size-4" />
            {picked.length === 2 ? "Compare selected" : `Pick ${2 - picked.length} to compare`}
          </Button>
        </header>
        {visible.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            {summary.sessions.length === 0
              ? "No sessions yet. Record someone doing this journey and add it here."
              : "No sessions match these filters."}
          </p>
        ) : (
          <ul className="divide-y">
            {visible.map((session) => {
              const runId = session.analysis?.id
              const comparable = runId && session.analysis?.total != null
              return (
                <li key={session.video_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${session.title} to compare`}
                    disabled={!comparable}
                    checked={!!runId && picked.includes(runId)}
                    onChange={() => runId && togglePick(runId)}
                    className="size-4"
                  />
                  <div className="min-w-0 flex-1">
                    <Link href={`/library/${session.video_id}`} className="truncate text-sm font-medium hover:underline">
                      {session.title}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <LocalTime value={session.created_at} format="date" />
                      {session.participant && <span>· {session.participant.label}</span>}
                      {session.participant?.cohorts.map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                      {session.variant && (
                        <span className="inline-flex items-center gap-1">
                          · <span className="size-2 rounded-full" style={{ background: colorFor(session) }} />
                          <span>{session.variant.name}</span>
                          {session.variant.build && <span>({session.variant.build})</span>}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-10 text-right text-sm font-semibold tabular-nums">
                      {session.analysis?.total ?? "–"}
                    </span>
                    {runId && (session.analysis?.status === "succeeded" || session.analysis?.status === "partial") ? (
                      <Button size="sm" variant="ghost" nativeButton={false} render={<Link href={`/reports/${runId}`} />}>
                        Report
                      </Button>
                    ) : (
                      <span className="w-16 text-xs text-muted-foreground">
                        {session.analysis ? session.analysis.status : "Not analyzed"}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
