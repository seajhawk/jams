"use client"

import { useEffect, useRef, useState } from "react"

import type { AnalysisErrorCode } from "@/lib/analysis-failure"

export type AnalysisStatus = "queued" | "running" | "succeeded" | "partial" | "failed"

export type AnalysisProgress = {
  id: string
  video_id: string
  status: AnalysisStatus
  stage: string
  progress_pct: number
  stage_detail: string | null
  error_code: AnalysisErrorCode | null
}

const TERMINAL: ReadonlySet<AnalysisStatus> = new Set(["succeeded", "partial", "failed"])

export function isTerminalStatus(status: AnalysisStatus) {
  return TERMINAL.has(status)
}

/** Matches the detail page's poll interval so both surfaces move in step. */
const POLL_MS = 2500

/**
 * Follows one analysis run until it reaches a terminal state. Fetches immediately so an overlay
 * shows real progress at once, then polls. `onSettled` fires exactly once per run when it finishes.
 * Pass `null` to follow nothing.
 */
export function useAnalysisProgress(
  runId: string | null,
  onSettled?: (analysis: AnalysisProgress) => void
) {
  const [analysis, setAnalysis] = useState<AnalysisProgress | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  // Kept in a ref so a new callback identity from the parent never restarts polling.
  const settledRef = useRef(onSettled)
  useEffect(() => {
    settledRef.current = onSettled
  }, [onSettled])

  useEffect(() => {
    if (!runId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnalysis(null)
      setUnavailable(false)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        const response = await fetch(`/api/analyses/${runId}`)
        if (!response.ok) throw new Error("status unavailable")
        const body = (await response.json()) as { analysis: AnalysisProgress }
        if (cancelled) return
        setUnavailable(false)
        setAnalysis(body.analysis)
        if (isTerminalStatus(body.analysis.status)) {
          settledRef.current?.(body.analysis)
          return
        }
      } catch {
        if (cancelled) return
        // A single failed poll must not abandon the run; keep trying and say so.
        setUnavailable(true)
      }
      timer = setTimeout(tick, POLL_MS)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId])

  return { analysis, unavailable }
}
