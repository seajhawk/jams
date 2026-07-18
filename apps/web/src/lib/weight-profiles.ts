import type { MeasureKind, Normalization } from "./report-contract"

export const DEFAULT_WEIGHT_PROFILE_NAME = "Default"

export const DEFAULT_WEIGHT_PROFILE_WEIGHTS = {
  context_switch: 3,
  sentiment: 4,
  spoken_word: 1,
  time_segment: 2,
} satisfies Partial<Record<MeasureKind, number>>

export const DEFAULT_WEIGHT_PROFILE_NORMALIZATION = {
  context_switch: "per_minute",
  sentiment: "neg_density",
  spoken_word: "per_minute",
  time_segment: "raw_minutes",
} satisfies Partial<Record<MeasureKind, Normalization>>
