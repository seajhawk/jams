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
};

export type NormalizedScores = Partial<Record<MeasureKind, NormalizedKindScore>>;

export type ScoreResult = {
  components: Record<MeasureCategory, number>;
  total: number;
  breakdown: Array<{
    kind: MeasureKind;
    raw: number;
    normalized: number;
    weight: number;
    contribution: number;
  }>;
};

const KIND_CATEGORY: Record<MeasureKind, MeasureCategory> = {
  context_switch: "cognitive",
  sentiment: "sentiment",
  spoken_word: "physical",
  time_segment: "time",
  utterance: "speech",
};

const SCORE_KIND_ORDER: MeasureKind[] = [
  "context_switch",
  "sentiment",
  "spoken_word",
  "time_segment",
  "utterance",
];

// Scale factors are intentionally fixed for TS/Python parity.
// They make the demo fixture land at readable 0-100 values:
// roughly 1.7 switches/min => 63, 18 words/min => 45.
const PER_MINUTE_SCALE: Partial<Record<MeasureKind, number>> = {
  context_switch: 36.75,
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

  if (kind === "spoken_word") {
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

function normalizeNegativeDensity(measures: ReportMeasure[]) {
  const sentimentMeasures = measuresForKind(measures, "sentiment");
  const narrationMs = sentimentMeasures.reduce((sum, measure) => {
    return sum + Math.max(0, (measure.t_end_ms ?? measure.t_start_ms) - measure.t_start_ms);
  }, 0);
  const negativeMs = sentimentMeasures.reduce((sum, measure) => {
    if ((measure.value_num ?? 0) >= -0.15) {
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

    if (mode === "per_minute") {
      scores[kind] = { kind, ...normalizePerMinute(kind, measures, video) };
      return scores;
    }

    if (mode === "neg_density") {
      scores[kind] = { kind, ...normalizeNegativeDensity(measures) };
      return scores;
    }

    scores[kind] = { kind, ...normalizeRawMinutes(video) };
    return scores;
  }, {});
}

export function score(
  normalized: NormalizedScores,
  weights: WeightProfile["weights"],
): ScoreResult {
  const activeKinds = SCORE_KIND_ORDER.filter((kind) => (weights[kind] ?? 0) > 0);
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
        : 0;

      return componentScores;
    },
    {
      physical: 0,
      cognitive: 0,
      time: 0,
      sentiment: 0,
      speech: 0,
    } satisfies Record<MeasureCategory, number>,
  );

  return {
    components,
    total: totalWeight > 0 ? roundWhole(weightedSum / totalWeight) : 0,
    breakdown: activeKinds.map((kind) => ({
      kind,
      raw: normalized[kind]?.raw ?? 0,
      normalized: normalized[kind]?.normalized ?? 0,
      weight: weights[kind] ?? 0,
      contribution: totalWeight > 0
        ? roundTenth(((normalized[kind]?.normalized ?? 0) * (weights[kind] ?? 0)) / totalWeight)
        : 0,
    })),
  };
}
