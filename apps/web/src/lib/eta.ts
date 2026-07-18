/**
 * Duration-based ETA estimation for the analysis pipeline.
 *
 * Stage weights (fraction of total pipeline progress):
 *   probe / normalize   10%
 *   context_switches    25%
 *   transcription       45%
 *   rest (segment/score/finalize) 20%
 *
 * TRANSCRIPTION_RTF — conservative planning factor:
 *   for every 1 ms of video, transcription takes 0.25 ms wall time.
 *   Measured benchmark on 2-vCPU ACA SKU: RTF ≈ 0.14;
 *   we use 0.25 to avoid over-promising on slower infra.
 */

export const STAGE_WEIGHTS = {
  probe: 0.10,
  scenes: 0.25,
  transcription: 0.45,
  rest: 0.20,
} as const

/** Conservative transcription real-time factor (wall_time / video_duration). */
export const TRANSCRIPTION_RTF = 0.25

/** Progress percentage at which we show "finishing up…" instead of a countdown. */
const FINISHING_UP_PCT = 95

function estimatedTotalMs(videoDurationMs: number): number {
  // Transcription dominates. Back-calculate total from transcription's share.
  return (videoDurationMs * TRANSCRIPTION_RTF) / STAGE_WEIGHTS.transcription
}

/**
 * Returns estimated remaining processing time in milliseconds.
 * Returns `0` when past FINISHING_UP_PCT (show "finishing up…").
 * Returns `null` when there is not enough information to estimate.
 */
export function estimateRemainingMs(
  progressPct: number,
  videoDurationMs: number | null | undefined,
): number | null {
  if (!videoDurationMs || videoDurationMs <= 0) return null
  if (progressPct >= FINISHING_UP_PCT) return 0
  const total = estimatedTotalMs(videoDurationMs)
  return total * (1 - progressPct / 100)
}

/**
 * Formats a remaining-ms value as a human-readable ETA string.
 * Returns `null` when `remainingMs` is `null` (no data).
 */
export function formatEta(remainingMs: number | null): string | null {
  if (remainingMs === null) return null
  if (remainingMs === 0) return "finishing up…"
  const minutes = Math.ceil(remainingMs / 60_000)
  if (minutes <= 1) return "~1 min left"
  return `~${minutes} min left`
}
