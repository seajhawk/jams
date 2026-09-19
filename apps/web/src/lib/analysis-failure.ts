export type AnalysisErrorCode =
  | "no_audio"
  | "too_long"
  | "corrupt_file"
  | "transient"
  | "unknown"

/** User-facing explanation for a failed analysis run. */
export function failureCopy(code: AnalysisErrorCode | null) {
  switch (code) {
    case "too_long":
      return "This video is over the 20-minute analysis limit."
    case "corrupt_file":
      return "The worker could not read this video file."
    case "no_audio":
      return "No narration audio was available for the requested stage."
    case "transient":
      return "The worker hit a temporary processing error."
    default:
      return "The worker could not finish this analysis."
  }
}
