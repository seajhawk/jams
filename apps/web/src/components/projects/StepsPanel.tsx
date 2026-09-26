"use client"

import { useCallback, useEffect, useState } from "react"
import { Play } from "lucide-react"

import { ClipPlayer } from "@/components/projects/ClipPlayer"
import { Button } from "@/components/ui/button"
import type { StepHotspot } from "@/lib/hotspots"

interface StepsView {
  steps: string[]
  hotspots: StepHotspot[]
  ranked: number[]
  estimated: boolean
  excluded: number
  suggestions: string[]
  sessions: { video_id: string }[]
}

const seconds = (ms: number | null) => (ms === null ? "–" : `${Math.round(ms / 1000)} s`)

/** Declared steps and where across sessions people struggle in each. */
export function StepsPanel({
  journeyId,
  cohort,
  variant,
}: {
  journeyId: string
  cohort: string | null
  variant: string | null
}) {
  const [view, setView] = useState<StepsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [playing, setPlaying] = useState<number | null>(null)

  const load = useCallback(async () => {
    const query = new URLSearchParams()
    if (cohort) query.set("cohort", cohort)
    if (variant) query.set("variant", variant)
    try {
      const response = await fetch(`/api/journeys/${journeyId}/steps?${query}`)
      if (!response.ok) throw new Error("Steps could not be loaded")
      setView((await response.json()) as StepsView)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Steps could not be loaded")
    }
  }, [journeyId, cohort, variant])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const startEditing = () => {
    setDraft((view?.steps.length ? view.steps : (view?.suggestions ?? [])).join("\n"))
    setEditing(true)
  }
  const save = async () => {
    setSaving(true)
    try {
      const steps = draft.split("\n").map((line) => line.trim()).filter(Boolean)
      const response = await fetch(`/api/tasks/${journeyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ steps }),
      })
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "Could not save")
      setEditing(false)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  if (error && !view) return <p className="text-sm text-destructive">{error}</p>
  if (!view) return <p className="text-sm text-muted-foreground">Loading steps…</p>

  if (editing || view.steps.length === 0) {
    return editing ? (
      <div className="space-y-2">
        <label htmlFor="journey-steps" className="text-sm">
          One step per line, in order
        </label>
        <textarea
          id="journey-steps"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={Math.max(4, draft.split("\n").length + 1)}
          className="w-full rounded-lg border border-input bg-transparent p-2 text-sm"
          placeholder={"Sign in\nChoose a plan\nConfigure settings"}
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save steps"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    ) : (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Name the steps of this journey and JAMS lines every session up step by step, then shows
          where people struggle.
          {view.suggestions.length > 0 && " It will start from the segment names it found."}
        </p>
        <Button size="sm" variant="outline" onClick={startEditing}>
          Declare steps
        </Button>
      </div>
    )
  }

  const hotspotsInOrder = view.ranked.map((index) => view.hotspots[index])
  return (
    <div className="space-y-3">
      {playing !== null && view.hotspots[playing].evidence.length > 0 && (
        <ClipPlayer
          key={playing}
          title={`${view.hotspots[playing].step}: moments of frustration`}
          moments={view.hotspots[playing].evidence}
          onClose={() => setPlaying(null)}
        />
      )}
      {view.sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No analyzed sessions to line up yet.</p>
      ) : (
        <table className="w-full text-sm" data-testid="hotspot-table">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">Step (worst first)</th>
              <th className="py-1 font-normal">Frustration</th>
              <th className="py-1 text-right font-normal">Avg time</th>
              <th className="py-1 text-right font-normal">Switches</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y">
            {hotspotsInOrder.map((hotspot) => (
              <tr key={hotspot.index}>
                <td className="py-2">{hotspot.step}</td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-rose-500"
                        style={{ width: `${hotspot.sessions ? (100 * hotspot.frustrated_sessions) / hotspot.sessions : 0}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums">
                      {hotspot.frustrated_sessions} of {hotspot.sessions}
                    </span>
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums">{seconds(hotspot.mean_duration_ms)}</td>
                <td className="py-2 text-right tabular-nums">{hotspot.mean_switches ?? "–"}</td>
                <td className="py-2 text-right">
                  {hotspot.frustrated_sessions > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setPlaying(hotspot.index)}>
                      <Play data-icon="inline-start" className="size-3.5" />
                      Play all {hotspot.frustrated_sessions}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {view.estimated && "Some sessions' steps are estimated by time; set boundaries on the session to be exact. "}
          {view.excluded > 0 && `${view.excluded} session${view.excluded === 1 ? "" : "s"} on an older scoring definition left out.`}
        </span>
        <Button size="sm" variant="ghost" onClick={startEditing}>
          Edit steps
        </Button>
      </div>
    </div>
  )
}
