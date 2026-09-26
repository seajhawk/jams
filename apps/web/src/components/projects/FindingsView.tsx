"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Bookmark, CheckCircle2, RotateCcw, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LocalTime } from "@/components/ui/local-time"
import { Skeleton } from "@/components/ui/skeleton"
import type { FindingSnapshot } from "@/lib/findings"

interface Finding {
  id: string
  title: string
  note: string | null
  kind: "comparison" | "hotspot" | "leaderboard"
  source: { journey_id?: string; goal_id?: string }
  snapshot: FindingSnapshot
  created_at: string
  live: { headline: string; changed: boolean } | null
}

const KIND_LABEL = { comparison: "Comparison", hotspot: "Friction hotspot", leaderboard: "Easiest way" }

function liveHref(finding: Finding) {
  if (finding.source.goal_id) return `/goals/${finding.source.goal_id}`
  if (finding.source.journey_id) return `/journeys/${finding.source.journey_id}`
  return null
}

/** Saved findings, each with the verdict as it was and whether today's data still supports it. */
export function FindingsView() {
  const [items, setItems] = useState<Finding[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch("/api/findings")
      if (!response.ok) throw new Error()
      setItems(((await response.json()) as { findings: Finding[] }).findings)
    } catch {
      setError("Findings could not be loaded. Check your connection and try again.")
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const remove = async (id: string) => {
    await fetch(`/api/findings/${id}`, { method: "DELETE" })
    setItems((current) => current?.filter((item) => item.id !== id) ?? null)
  }

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
  if (!items) return <Skeleton className="h-40 w-full" />
  if (items.length === 0) {
    return (
      <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-dashed p-8 text-center">
        <div className="max-w-md">
          <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
            <Bookmark className="size-5 text-muted-foreground" />
          </div>
          <h2 className="mt-5 text-lg font-medium">No findings yet</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            When a comparison, a friction hotspot or a goal&apos;s easiest way tells you something,
            use <strong>Save as finding</strong>. JAMS freezes the numbers and tells you later if
            new sessions change the picture.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ul className="space-y-3">
      {items.map((finding) => {
        const href = liveHref(finding)
        return (
          <li key={finding.id} data-testid="finding" className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {KIND_LABEL[finding.kind]} · {finding.snapshot.label}
                </p>
                <h2 className="mt-0.5 font-medium">{finding.title}</h2>
              </div>
              <Button size="sm" variant="ghost" onClick={() => remove(finding.id)} aria-label={`Delete ${finding.title}`}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            <p className="mt-2 text-sm">{finding.snapshot.headline}</p>
            {finding.note && <p className="mt-1 text-sm text-muted-foreground">{finding.note}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                Saved <LocalTime value={finding.created_at} format="date" />
              </span>
              {finding.live === null ? (
                <span className="text-amber-600">The journey or goal it refers to is gone.</span>
              ) : finding.live.changed ? (
                <span className="inline-flex items-center gap-1 text-amber-600">
                  <AlertTriangle className="size-3.5" />
                  No longer holds. Now: {finding.live.headline}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-600">
                  <CheckCircle2 className="size-3.5" />
                  Still holds
                </span>
              )}
              {href && (
                <Link href={href} className="underline">
                  See it live
                </Link>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
