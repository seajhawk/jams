"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const toClock = (ms: number) => {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}
const fromClock = (text: string): number | null => {
  const match = /^(\d+):([0-5]\d)$/.exec(text.trim()) ?? /^(\d+)$/.exec(text.trim())
  if (!match) return null
  return match.length === 3 ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : Number(match[1]) * 1000
}

/** Place the cuts between a journey's steps on this session so step comparisons are exact. */
export function StepBoundaryEditor({
  videoId,
  steps,
  durationMs,
  boundariesMs,
}: {
  videoId: string
  steps: string[]
  durationMs: number
  boundariesMs: number[] | null
}) {
  const router = useRouter()
  const initial =
    boundariesMs ?? steps.slice(1).map((_, index) => Math.round((durationMs * (index + 1)) / steps.length))
  const [values, setValues] = useState(initial.map(toClock))
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const parsed = values.map(fromClock)
    if (parsed.some((value) => value === null)) {
      setStatus("Use minutes:seconds, like 1:05.")
      return
    }
    setBusy(true)
    const response = await fetch(`/api/videos/${videoId}/step-boundaries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boundaries_ms: parsed }),
    })
    setBusy(false)
    if (!response.ok) {
      setStatus(((await response.json()) as { error?: string }).error ?? "Could not save")
      return
    }
    setStatus("Saved. Journey step comparisons now use these times.")
    router.refresh()
  }
  const reset = async () => {
    setBusy(true)
    await fetch(`/api/videos/${videoId}/step-boundaries`, { method: "DELETE" })
    setBusy(false)
    setStatus("Back to automatic alignment.")
    router.refresh()
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-muted-foreground">
        {boundariesMs ? "Set by hand." : "Not set: steps are aligned automatically."} Each time is where
        the next step begins.
      </p>
      <ol className="space-y-1.5">
        <li className="text-xs text-muted-foreground">0:00 · {steps[0]}</li>
        {values.map((value, index) => (
          <li key={steps[index + 1]} className="flex items-center gap-2">
            <Input
              aria-label={`Start of ${steps[index + 1]}`}
              value={value}
              onChange={(event) =>
                setValues((current) => current.map((v, i) => (i === index ? event.target.value : v)))
              }
              className="h-7 w-16"
            />
            <span className="truncate text-xs">{steps[index + 1]}</span>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>
          Save steps
        </Button>
        {boundariesMs && (
          <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
            Reset
          </Button>
        )}
      </div>
      {status && <p className="text-xs text-muted-foreground">{status}</p>}
    </div>
  )
}
