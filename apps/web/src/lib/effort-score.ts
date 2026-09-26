import type {
  MeasureCategory,
  MeasureKind,
  Normalization,
  ReportMeasure,
  ReportVideo,
  WeightProfile,
} from "./report-contract";

export type NormalizedKindScore = {
  kind: MeasureKind;
  raw: number;
  normalized: number;
  /** Whether this recording could measure the kind at all. Unmeasured is not zero. */
  measured: boolean;
};

export type NormalizedScores = Partial<Record<MeasureKind, NormalizedKindScore>>;

export type ScoreResult = {
  /** null = nothing in the category was measured for this recording. */
  components: Record<MeasureCategory, number | null>;
  total: number | null;
  breakdown: Array<{
    kind: MeasureKind;
    raw: number;
    normalized: number;
    weight: number;
    measured: boolean;
    contribution: number;
  }>;
};

export const KIND_CATEGORY: Record<MeasureKind, MeasureCategory> = {
  clicks: "physical",
  context_switch: "cognitive",
  keypresses: "physical",
  sentiment: "sentiment",
  scrolls: "physical",
  // Words per minute is speech, not physical effort (preview review B6).
  spoken_word: "speech",
  time_segment: "time",
  utterance: "speech",
};

const SCORE_KIND_ORDER: MeasureKind[] = [
  "clicks",
  "context_switch",
  "keypresses",
  "sentiment",
  "scrolls",
  "spoken_word",
  "time_segment",
  "utterance",
];

// Scale factors are intentionally fixed for TS/Python parity.
// They make the demo fixture land at readable 0-100 values:
// roughly 1.7 switches/min => 63, 18 words/min => 45.
const PER_MINUTE_SCALE: Partial<Record<MeasureKind, number>> = {
  clicks: 1,
  context_switch: 36.75,
  keypresses: 1,
  spoken_word: 2.47,
  utterance: 10,
};

const roundWhole = (value: number) => Math.round(value);
const roundTenth = (value: number) => Math.round(value * 10) / 10;
const clampScore = (value: number) => Math.max(0, Math.min(100, value));

function measuresForKind(measures: ReportMeasure[], kind: MeasureKind) {
  return measures.filter((measure) => measure.kind === kind);
}

function durationMinutes(video: ReportVideo) {
  return video.duration_ms / 60_000;
}

function perMinuteRaw(kind: MeasureKind, measures: ReportMeasure[]) {
  const kindMeasures = measuresForKind(measures, kind);

  if (kind === "keypresses" || kind === "spoken_word") {
    return kindMeasures.reduce((sum, measure) => sum + (measure.value_num ?? 0), 0);
  }

  return kindMeasures.length;
}

function normalizePerMinute(kind: MeasureKind, measures: ReportMeasure[], video: ReportVideo) {
  const raw = perMinuteRaw(kind, measures);
  const scale = PER_MINUTE_SCALE[kind] ?? 1;
  const rate = durationMinutes(video) > 0 ? raw / durationMinutes(video) : 0;

  return {
    raw,
    normalized: roundWhole(clampScore(rate * scale)),
  };
}

/**
 * An utterance counts toward negative narration time at or below this value; the report's
 * "worth attention" line uses the same constant. Keep in sync with the worker's effort_score.py.
 */
export const NEGATIVE_SENTIMENT_THRESHOLD = -0.3

function normalizeNegativeDensity(measures: ReportMeasure[]) {
  const sentimentMeasures = measuresForKind(measures, "sentiment");
  const narrationMs = sentimentMeasures.reduce((sum, measure) => {
    return sum + Math.max(0, (measure.t_end_ms ?? measure.t_start_ms) - measure.t_start_ms);
  }, 0);
  const negativeMs = sentimentMeasures.reduce((sum, measure) => {
    if ((measure.value_num ?? 0) > NEGATIVE_SENTIMENT_THRESHOLD) {
      return sum;
    }

    return sum + Math.max(0, (measure.t_end_ms ?? measure.t_start_ms) - measure.t_start_ms);
  }, 0);
  const share = narrationMs > 0 ? negativeMs / narrationMs : 0;

  return {
    raw: roundTenth(share),
    normalized: roundWhole(clampScore(share * 250)),
  };
}

function normalizeRawMinutes(video: ReportVideo) {
  const minutes = durationMinutes(video);

  return {
    raw: roundTenth(minutes),
    normalized: roundWhole(clampScore(minutes * (100 / 30))),
  };
}

/**
 * Whether this recording could measure the kind at all (mirrors is_measured in the worker).
 * Speech kinds need audio (audio with silence is a real zero); sentiment needs speech to classify;
 * context switches and time come from the video; the experimental physical detectors count only
 * when they produced something.
 */
export function isMeasured(kind: MeasureKind, measures: ReportMeasure[], video: ReportVideo): boolean {
  if (kind === "spoken_word" || kind === "utterance") return video.has_audio !== false;
  if (kind === "sentiment") return measuresForKind(measures, "sentiment").length > 0;
  if (kind === "context_switch" || kind === "time_segment") return true;
  return measuresForKind(measures, kind).length > 0;
}

export function normalize(
  measures: ReportMeasure[],
  video: ReportVideo,
  normalization: Partial<Record<MeasureKind, Normalization>>,
): NormalizedScores {
  return SCORE_KIND_ORDER.reduce<NormalizedScores>((scores, kind) => {
    const mode = normalization[kind];

    if (!mode) {
      return scores;
    }

    const measured = isMeasured(kind, measures, video);

    if (mode === "per_minute") {
      scores[kind] = { kind, ...normalizePerMinute(kind, measures, video), measured };
      return scores;
    }

    if (mode === "neg_density") {
      scores[kind] = { kind, ...normalizeNegativeDensity(measures), measured };
      return scores;
    }

    scores[kind] = { kind, ...normalizeRawMinutes(video), measured };
    return scores;
  }, {});
}

export function score(
  normalized: NormalizedScores,
  weights: WeightProfile["weights"],
): ScoreResult {
  const weightedKinds = SCORE_KIND_ORDER.filter((kind) => (weights[kind] ?? 0) > 0);
  // Only kinds this recording could measure take part, in numerator and denominator alike, so a
  // missing signal never drags the score toward zero. A kind with no normalization is missing.
  const activeKinds = weightedKinds.filter((kind) => normalized[kind]?.measured ?? false);
  const totalWeight = activeKinds.reduce((sum, kind) => sum + (weights[kind] ?? 0), 0);

  const weightedSum = activeKinds.reduce((sum, kind) => {
    return sum + ((normalized[kind]?.normalized ?? 0) * (weights[kind] ?? 0));
  }, 0);

  const components = (["physical", "cognitive", "time", "sentiment", "speech"] as const).reduce(
    (componentScores, category) => {
      const categoryKinds = activeKinds.filter((kind) => KIND_CATEGORY[kind] === category);
      const categoryWeight = categoryKinds.reduce((sum, kind) => sum + (weights[kind] ?? 0), 0);
      const categoryWeightedSum = categoryKinds.reduce((sum, kind) => {
        return sum + ((normalized[kind]?.normalized ?? 0) * (weights[kind] ?? 0));
      }, 0);

      componentScores[category] = categoryWeight > 0
        ? roundWhole(categoryWeightedSum / categoryWeight)
        : null;

      return componentScores;
    },
    {
      physical: null,
      cognitive: null,
      time: null,
      sentiment: null,
      speech: null,
    } as Record<MeasureCategory, number | null>,
  );

  return {
    components,
    total: totalWeight > 0 ? roundWhole(weightedSum / totalWeight) : null,
    // Weighted kinds that were not measured stay listed (measured: false) so the report can say
    // what is missing rather than implying a zero.
    breakdown: weightedKinds.map((kind) => {
      const measured = activeKinds.includes(kind);
      return {
        kind,
        raw: normalized[kind]?.raw ?? 0,
        normalized: normalized[kind]?.normalized ?? 0,
        weight: weights[kind] ?? 0,
        measured,
        contribution: totalWeight > 0 && measured
          ? roundTenth(((normalized[kind]?.normalized ?? 0) * (weights[kind] ?? 0)) / totalWeight)
          : 0,
      };
    }),
  };
}
