export type AnalysisErrorCode =
  | "no_audio"
  | "too_long"
  | "corrupt_file"
  | "transient"
  | "unknown"
  | "too_large"
  | "unsupported_media"

/** User-facing explanation for a failed analysis run. */
export function failureCopy(code: AnalysisErrorCode | null) {
  switch (code) {
    case "too_long":
      return "This video is over the 20-minute analysis limit."
    case "corrupt_file":
      return "The worker could not read this video file."
    case "too_large":
      return "This video file is larger than the upload limit."
    case "unsupported_media":
      return "This video's resolution or format is not supported. Re-export it as an H.264 MP4 at 4K or below."
    case "no_audio":
      return "No narration audio was available for the requested stage."
    case "transient":
      return "The worker hit a temporary processing error."
    default:
      return "The worker could not finish this analysis."
  }
}
