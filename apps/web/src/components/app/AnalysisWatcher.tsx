"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"

import { failureCopy, type AnalysisErrorCode } from "@/lib/analysis-failure"
import {
  onAnalysisStarted,
  showAnalysisNotification,
} from "@/lib/analysis-watch"

type ActiveRun = {
  id: string
  video_title: string | null
  status: string
}

type SettledRun = {
  id: string
  status: string
  error_code: AnalysisErrorCode | null
}

/** While work is in flight, matching the library overlay so both surfaces move in step. */
const ACTIVE_POLL_MS = 2500
/** Nothing running: a slow heartbeat that catches a run someone started in another tab. */
const IDLE_POLL_MS = 30_000

function titleOf(run: { video_title: string | null }) {
  return run.video_title ?? "your recording"
}

/**
 * Follows every analysis this organization has in flight, wherever the user happens to be in the
 * app, and says so when one finishes. The library card keeps its own overlay for live progress;
 * this component owns the completion announcement so it happens exactly once and on any page.
 *
 * Only runs seen active during this session are announced, so opening the app does not replay
 * completions the user already knows about.
 */
export function AnalysisWatcher() {
  const router = useRouter()
  const tracked = useRef(new Map<string, ActiveRun>())
  const announced = useRef(new Set<string>())
  const unseen = useRef(0)
  const baseTitle = useRef<string | null>(null)
  const pollNow = useRef<() => void>(() => {})

  const refreshTabTitle = useCallback(() => {
    if (typeof document === "undefined") return
    baseTitle.current ??= document.title
    const base = baseTitle.current
    document.title = unseen.current > 0 ? `(${unseen.current}) Analysis ready - ${base}` : base
  }, [])

  const announce = useCallback(
    (run: ActiveRun, settled: SettledRun) => {
      const name = titleOf(run)
      const hidden = typeof document !== "undefined" && document.hidden
      if (hidden) {
        unseen.current += 1
        refreshTabTitle()
      }

      if (settled.status === "failed") {
        toast.error(`Analysis failed: ${name}`, { description: failureCopy(settled.error_code) })
        if (hidden) {
          showAnalysisNotification("Analysis failed", `${name}: ${failureCopy(settled.error_code)}`, settled.id)
        }
        return
      }

      toast.success(`Analysis complete: ${name}`, {
        action: { label: "View report", onClick: () => router.push(`/reports/${settled.id}`) },
      })
      if (hidden) {
        showAnalysisNotification("Analysis complete", `${name} is ready to review.`, settled.id)
      }
    },
    [refreshTabTitle, router]
  )

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    /** A run that left the active list: ask what it settled as, then say so once. */
    const settle = async (run: ActiveRun) => {
      if (announced.current.has(run.id)) return
      announced.current.add(run.id)
      try {
        const response = await fetch(`/api/analyses/${run.id}`)
        if (!response.ok) throw new Error("unavailable")
        const { analysis } = (await response.json()) as { analysis: SettledRun }
        if (cancelled) return
        announce(run, analysis)
        // The library list and any open report were rendered before this finished.
        router.refresh()
      } catch {
        // The run did finish; we just could not learn how. It is already off the active list, so
        // put it back under watch or the next poll would never notice it again.
        announced.current.delete(run.id)
        tracked.current.set(run.id, run)
      }
    }

    const tick = async () => {
      let active: ActiveRun[] | null = null
      try {
        const response = await fetch("/api/analyses?active=1")
        if (response.ok) {
          active = ((await response.json()) as { analyses: ActiveRun[] }).analyses
        }
      } catch {
        // Offline or a blip. Keep whatever we were tracking and try again.
      }
      if (cancelled) return

      if (active) {
        const stillActive = new Set(active.map((run) => run.id))
        const finished: ActiveRun[] = []
        for (const [id, run] of tracked.current) {
          if (!stillActive.has(id)) {
            tracked.current.delete(id)
            finished.push(run)
          }
        }
        for (const run of active) tracked.current.set(run.id, run)
        // Settled before choosing the next interval: a lookup that fails puts its run back under
        // watch, and that has to count when deciding whether we are still busy.
        await Promise.all(finished.map(settle))
        if (cancelled) return
      }

      const interval = tracked.current.size > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS
      timer = setTimeout(tick, interval)
    }

    const restart = () => {
      if (timer) clearTimeout(timer)
      void tick()
    }
    pollNow.current = restart

    void tick()
    const stopListening = onAnalysisStarted(restart)

    return () => {
      cancelled = true
      stopListening()
      if (timer) clearTimeout(timer)
      pollNow.current = () => {}
    }
  }, [announce, router])

  // Coming back to the tab clears the badge, and is a good moment to look for news.
  useEffect(() => {
    if (typeof document === "undefined") return
    const onVisible = () => {
      if (document.hidden) return
      if (unseen.current > 0) {
        unseen.current = 0
        refreshTabTitle()
      }
      pollNow.current()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      if (baseTitle.current !== null) document.title = baseTitle.current
    }
  }, [refreshTabTitle])

  return null
}
