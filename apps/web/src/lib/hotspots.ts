/**
 * Cross-session friction hotspots (U3): per declared step, how many sessions hit frustration there,
 * how long people spent, and the moments to play back. Pure; client-safe.
 */
import { FRUSTRATED_THRESHOLD } from "@/lib/report-moments"
import type { Alignment } from "@/lib/steps"

export interface HotspotMeasure {
  kind: string
  t_start_ms: number
  value_num: number | null
  /** The words said, when the measure is sentiment linked to an utterance. */
  text?: string | null
}

export interface HotspotSession {
  video_id: string
  run_id: string
  title: string
  participant_label: string | null
  alignment: Alignment
  measures: HotspotMeasure[]
}

export interface EvidenceMoment {
  video_id: string
  run_id: string
  title: string
  participant_label: string | null
  t_ms: number
  value: number
  text: string | null
}

export interface StepHotspot {
  step: string
  index: number
  sessions: number
  frustrated_sessions: number
  mean_duration_ms: number | null
  mean_switches: number | null
  evidence: EvidenceMoment[]
}

const mean = (values: number[]) =>
  values.length ? Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10 : null

export function computeHotspots(steps: string[], sessions: HotspotSession[]): StepHotspot[] {
  return steps.map((step, index) => {
    const durations: number[] = []
    const switches: number[] = []
    const evidence: EvidenceMoment[] = []
    for (const session of sessions) {
      const span = session.alignment.steps[index]
      if (!span) continue
      const inSpan = (m: HotspotMeasure) => m.t_start_ms >= span.t_start_ms && m.t_start_ms < span.t_end_ms
      durations.push(span.t_end_ms - span.t_start_ms)
      switches.push(session.measures.filter((m) => m.kind === "context_switch" && inSpan(m)).length)
      const worst = session.measures
        .filter((m) => m.kind === "sentiment" && m.value_num !== null && m.value_num <= FRUSTRATED_THRESHOLD && inSpan(m))
        .sort((a, b) => (a.value_num as number) - (b.value_num as number) || a.t_start_ms - b.t_start_ms)[0]
      if (worst) {
        evidence.push({
          video_id: session.video_id,
          run_id: session.run_id,
          title: session.title,
          participant_label: session.participant_label,
          t_ms: worst.t_start_ms,
          value: worst.value_num as number,
          text: worst.text ?? null,
        })
      }
    }
    return {
      step,
      index,
      sessions: durations.length,
      frustrated_sessions: evidence.length,
      mean_duration_ms: mean(durations),
      mean_switches: mean(switches),
      evidence: evidence.sort((a, b) => a.value - b.value),
    }
  })
}

/** Worst first: share of sessions frustrated, then mean time in the step, then step order. */
export function rankHotspots(hotspots: StepHotspot[]): StepHotspot[] {
  const rate = (h: StepHotspot) => (h.sessions ? h.frustrated_sessions / h.sessions : 0)
  return [...hotspots].sort(
    (a, b) =>
      rate(b) - rate(a) ||
      (b.mean_duration_ms ?? 0) - (a.mean_duration_ms ?? 0) ||
      a.index - b.index
  )
}
