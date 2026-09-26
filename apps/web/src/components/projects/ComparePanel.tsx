"use client"

import { useEffect, useState } from "react"

import type { GroupComparison } from "@/lib/stats"

type CompareBy = "variant" | "cohort"

interface CompareResponse {
  excluded: number
  comparison: GroupComparison
  points: { a: { video_id: string; title: string; total: number }[]; b: { video_id: string; title: string; total: number }[] }
}

const VERDICT_TONE: Record<string, string> = {
  lower: "border-emerald-500/40 bg-emerald-500/5",
  higher: "border-rose-500/40 bg-rose-500/5",
  no_difference: "border-border bg-muted/40",
  too_few: "border-border bg-muted/40",
}

function DotRow({ label, points, color }: { label: string; points: { title: string; total: number }[]; color: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2">
      <span className="truncate text-xs font-medium" title={label}>
        {label}
      </span>
      <svg viewBox="0 0 400 24" className="h-6 w-full" aria-label={`${label}: ${points.length} sessions`}>
        <line x1="10" x2="390" y1="12" y2="12" className="stroke-border" strokeWidth="2" />
        {points.map((point, index) => (
          <circle
            key={`${point.title}-${index}`}
            cx={10 + point.total * 3.8}
            cy={12 + ((index % 3) - 1) * 4}
            r="5"
            fill={color}
            fillOpacity="0.75"
          >
            <title>{`${point.title}: ${point.total}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  )
}

/** Compare two variants or two cohorts of one journey, with the verdict in plain words. */
export function ComparePanel({
  journeyId,
  variants,
  cohorts,
}: {
  journeyId: string
  variants: string[]
  cohorts: string[]
}) {
  const initialBy: CompareBy | null = variants.length >= 2 ? "variant" : cohorts.length >= 2 ? "cohort" : null
  const [by, setBy] = useState<CompareBy | null>(initialBy)
  const options = by === "variant" ? variants : by === "cohort" ? cohorts : []
  const [a, setA] = useState(options[0] ?? "")
  const [b, setB] = useState(options[1] ?? "")
  // Each response is tagged with the selection it answers; only a matching one is ever shown, so
  // a slow or failed request never puts old numbers under newly chosen group labels.
  const [response, setResponse] = useState<{ key: string; data: CompareResponse } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const selectionKey = `${by}|${a}|${b}`
  const result = response?.key === selectionKey ? response.data : null

  useEffect(() => {
    if (!by || !a || !b || a === b) return
    let cancelled = false
    fetch(`/api/journeys/${journeyId}/compare?by=${by}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error ?? "Comparison failed")
        return (await response.json()) as CompareResponse
      })
      .then((data) => {
        if (!cancelled) setResponse({ key: `${by}|${a}|${b}`, data })
      })
      .catch((caught: Error) => !cancelled && setError({ key: `${by}|${a}|${b}`, message: caught.message }))
    return () => {
      cancelled = true
    }
  }, [journeyId, by, a, b])

  if (!initialBy) {
    return (
      <p className="text-sm text-muted-foreground">
        Tag sessions with at least two variants (A and B, or before and after a fix) or two cohorts
        (beginner and expert) to compare them here.
      </p>
    )
  }

  const switchTo = (next: CompareBy) => {
    const nextOptions = next === "variant" ? variants : cohorts
    setBy(next)
    setA(nextOptions[0] ?? "")
    setB(nextOptions[1] ?? "")
    setResponse(null)
  }
  const select = (value: string, onChange: (v: string) => void, label: string) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="flex rounded-lg border p-0.5">
          {(["variant", "cohort"] as const).map((mode) => {
            const available = (mode === "variant" ? variants : cohorts).length >= 2
            return (
              <button
                key={mode}
                type="button"
                disabled={!available}
                aria-pressed={by === mode}
                onClick={() => switchTo(mode)}
                className={`rounded-md px-3 py-1 text-xs disabled:opacity-40 ${by === mode ? "bg-primary text-primary-foreground" : ""}`}
              >
                By {mode}
              </button>
            )
          })}
        </div>
        {select(a, setA, "First group")}
        <span className="text-muted-foreground">vs</span>
        {select(b, setB, "Second group")}
      </div>

      {a === b && <p className="text-sm text-muted-foreground">Choose two different groups.</p>}
      {error?.key === selectionKey && <p className="text-sm text-destructive">{error.message}</p>}

      {result && a !== b && (
        <div className="space-y-3">
          <p
            data-testid="compare-verdict"
            className={`rounded-lg border p-3 text-sm ${VERDICT_TONE[result.comparison.verdict.kind]}`}
          >
            {result.comparison.verdict.text}
          </p>
          <div className="space-y-1.5">
            <DotRow label={`${a} (n=${result.comparison.a.n})`} points={result.points.a} color="#64748b" />
            <DotRow label={`${b} (n=${result.comparison.b.n})`} points={result.points.b} color="#2563eb" />
          </div>
          <p className="text-xs text-muted-foreground">
            Medians {result.comparison.a.median ?? "–"} vs {result.comparison.b.median ?? "–"}.
            {result.excluded > 0 &&
              ` ${result.excluded} session${result.excluded === 1 ? " was" : "s were"} left out because ${
                result.excluded === 1 ? "it was" : "they were"
              } scored with an older definition.`}
          </p>
        </div>
      )}
    </div>
  )
}
