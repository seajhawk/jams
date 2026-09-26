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
