/** Client-safe statistics shared by server summaries and journey-page filters. */

/** Median and quartiles by linear interpolation (the "type 7" definition spreadsheets use). */
export function summarizeTotals(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const quantile = (q: number) => {
    if (n === 0) return null
    const position = (n - 1) * q
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
    return Math.round(value * 10) / 10
  }
  return { n, median: quantile(0.5), p25: quantile(0.25), p75: quantile(0.75) }
}

/** Deterministic PRNG (mulberry32): identical data always yields identical intervals. */
export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * Difference of medians (b minus a) with a 95% percentile bootstrap interval. Both groups must be
 * non-empty.
 */
export function bootstrapMedianDifference(
  a: number[],
  b: number[],
  { resamples = 2000, seed = 0x5eed } = {}
) {
  const random = mulberry32(seed)
  const draw = (values: number[]) =>
    Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)])
  const differences = Array.from({ length: resamples }, () => median(draw(b)) - median(draw(a)))
  differences.sort((x, y) => x - y)
  const at = (q: number) => differences[Math.min(resamples - 1, Math.floor(q * resamples))]
  return { difference: round1(median(b) - median(a)), low: round1(at(0.025)), high: round1(at(0.975)) }
}

/** Below this many scored sessions per group, JAMS does not call a winner (guidance only). */
export const MIN_SESSIONS_PER_GROUP = 5

export type Verdict =
  | { kind: "too_few"; text: string }
  | { kind: "lower" | "higher" | "no_difference"; text: string }

export interface GroupComparison {
  a: { name: string } & ReturnType<typeof summarizeTotals>
  b: { name: string } & ReturnType<typeof summarizeTotals>
  difference: number | null
  low: number | null
  high: number | null
  verdict: Verdict
}

export function compareGroups(
  a: { name: string; values: number[] },
  b: { name: string; values: number[] },
  minN = MIN_SESSIONS_PER_GROUP
): GroupComparison {
  const summaryA = { name: a.name, ...summarizeTotals(a.values) }
  const summaryB = { name: b.name, ...summarizeTotals(b.values) }
  const shortfall = [a, b]
    .filter((group) => group.values.length < minN)
    .map((group) => `${minN - group.values.length} more in ${group.name}`)
  const interval =
    a.values.length && b.values.length ? bootstrapMedianDifference(a.values, b.values) : null

  let verdict: Verdict
  if (shortfall.length) {
    verdict = {
      kind: "too_few",
      text: `Too few sessions to call this. Record at least ${shortfall.join(" and ")}.`,
    }
  } else if (interval && (interval.low > 0 || interval.high < 0)) {
    const lower = interval.difference < 0
    verdict = {
      kind: lower ? "lower" : "higher",
      text: `${b.name} takes ${lower ? "less" : "more"} effort than ${a.name}: median ${Math.abs(
        interval.difference
      )} ${lower ? "lower" : "higher"} (95% range ${interval.low} to ${interval.high}).`,
    }
  } else {
    verdict = {
      kind: "no_difference",
      text: interval
        ? `No clear difference yet (the 95% range ${interval.low} to ${interval.high} includes zero).`
        : "No clear difference yet.",
    }
  }
  return {
    a: summaryA,
    b: summaryB,
    difference: interval?.difference ?? null,
    low: interval?.low ?? null,
    high: interval?.high ?? null,
    verdict,
  }
}

/**
 * Comparisons use one scoring definition: the fingerprint of the newest scored analysis that
 * recorded one. Sessions scored under any other definition, or with no recorded fingerprint, are
 * excluded and counted; unrecorded definitions are never comparable, even with each other.
 */
export function splitByReferenceFingerprint<
  T extends { analysis: { total: number | null; fingerprint_hash: string | null; created_at: string } | null },
>(sessions: T[]) {
  const scored = sessions.filter((session) => session.analysis?.total != null)
  const newest = scored
    .filter((session) => session.analysis!.fingerprint_hash)
    .sort((x, y) => (y.analysis!.created_at ?? "").localeCompare(x.analysis!.created_at ?? ""))[0]
  const reference = newest?.analysis?.fingerprint_hash ?? null
  const included =
    reference === null ? [] : scored.filter((session) => session.analysis!.fingerprint_hash === reference)
  return { reference, included, excluded: scored.length - included.length }
}
