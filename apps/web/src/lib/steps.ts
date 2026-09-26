/**
 * Step alignment (U3, docs/specs/u3-steps-and-hotspots.md): place a journey's declared steps on one
 * session's timeline. Pure and deterministic; client-safe.
 */

export interface SegmentSpan {
  name: string
  t_start_ms: number
  t_end_ms: number
}

export type AlignmentSource = "manual" | "matched" | "even"

export interface StepSpan {
  step: string
  t_start_ms: number
  t_end_ms: number
}

export interface Alignment {
  source: AlignmentSource
  steps: StepSpan[]
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "into", "from", "your", "you", "our", "this", "that", "then"])

/** Lowercased word stems: letters only, words of 3+ letters, stop words dropped, simple suffixes stripped. */
export function stems(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []
  const result = new Set<string>()
  for (const word of words) {
    if (word.length <= 2 || STOP_WORDS.has(word)) continue
    // Strip in order so inflections meet: plural, then -ing/-ed, then a trailing e
    // ("settings"/"setting" -> "sett", "configuring"/"configure" -> "configur").
    let stem = word
    if (stem.length > 3 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1)
    if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3)
    else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2)
    if (stem.length > 3 && stem.endsWith("e")) stem = stem.slice(0, -1)
    result.add(stem)
  }
  return result
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

function evenSplit(steps: string[], durationMs: number): StepSpan[] {
  return steps.map((step, index) => ({
    step,
    t_start_ms: Math.round((durationMs * index) / steps.length),
    t_end_ms: Math.round((durationMs * (index + 1)) / steps.length),
  }))
}

function fromBoundaries(steps: string[], boundaries: number[], durationMs: number): StepSpan[] {
  const cuts = [0, ...boundaries, durationMs]
  return steps.map((step, index) => ({ step, t_start_ms: cuts[index], t_end_ms: cuts[index + 1] }))
}

/** Manual boundaries are usable when there are exactly m−1, strictly increasing, inside the session. */
export function validBoundaries(boundaries: number[], stepCount: number, durationMs: number): boolean {
  if (boundaries.length !== stepCount - 1) return false
  let previous = 0
  for (const cut of boundaries) {
    if (!Number.isFinite(cut) || cut <= previous || cut >= durationMs) return false
    previous = cut
  }
  return true
}

/**
 * Best partition of k ordered segments into m consecutive runs. Each segment votes for the step its
 * name resembles (similarity of the two word-stem sets); a partition's score is the sum of those
 * votes, and every step must receive at least one positive vote. Returns the run start indexes, or
 * null when no partition matches every step.
 */
function matchSegments(steps: string[], segments: SegmentSpan[]): number[] | null {
  const m = steps.length
  const k = segments.length
  if (k < m || m === 0) return null
  const stepStems = steps.map(stems)
  const votes = segments.map((segment) => {
    const segmentStems = stems(segment.name)
    return stepStems.map((step) => similarity(step, segmentStems))
  })
  const runScore = (step: number, from: number, to: number) => {
    let total = 0
    let matched = false
    for (let i = from; i < to; i += 1) {
      total += votes[i][step]
      if (votes[i][step] > 0) matched = true
    }
    return matched ? total : 0
  }

  // best[s][j]: best total for steps 0..s-1 covering segments 0..j-1; -1 = unreachable.
  const best = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(-1))
  const cut = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(-1))
  best[0][0] = 0
  for (let s = 1; s <= m; s += 1) {
    for (let j = s; j <= k - (m - s); j += 1) {
      for (let i = s - 1; i < j; i += 1) {
        if (best[s - 1][i] < 0) continue
        const score = runScore(s - 1, i, j)
        if (score <= 0) continue // every step must match something
        const total = best[s - 1][i] + score
        // Strict > keeps the earliest cut on ties, so results are deterministic.
        if (total > best[s][j]) {
          best[s][j] = total
          cut[s][j] = i
        }
      }
    }
  }
  if (best[m][k] < 0) return null
  const starts = new Array<number>(m)
  let j = k
  for (let s = m; s >= 1; s -= 1) {
    starts[s - 1] = cut[s][j]
    j = cut[s][j]
  }
  return starts
}

export function alignSteps(input: {
  steps: string[]
  segments: SegmentSpan[]
  durationMs: number
  manualBoundariesMs?: number[] | null
}): Alignment {
  const { steps, durationMs } = input
  if (steps.length === 0) return { source: "even", steps: [] }

  if (input.manualBoundariesMs && validBoundaries(input.manualBoundariesMs, steps.length, durationMs)) {
    return { source: "manual", steps: fromBoundaries(steps, input.manualBoundariesMs, durationMs) }
  }

  const segments = [...input.segments].sort((a, b) => a.t_start_ms - b.t_start_ms)
  const starts = matchSegments(steps, segments)
  if (starts) {
    return {
      source: "matched",
      steps: steps.map((step, index) => ({
        step,
        t_start_ms: index === 0 ? 0 : segments[starts[index]].t_start_ms,
        t_end_ms: index === steps.length - 1 ? durationMs : segments[starts[index + 1]].t_start_ms,
      })),
    }
  }
  return { source: "even", steps: evenSplit(steps, durationMs) }
}
