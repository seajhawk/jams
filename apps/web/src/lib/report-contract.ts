import { z } from "zod";

const uuidSchema = z.uuid();
const isoDateTimeSchema = z.iso.datetime({ offset: true });

const rootRelativeOrAbsoluteUrlSchema = z.string().min(1).refine(
  (value) => {
    if (value.startsWith("/")) {
      return true;
    }

    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Expected an absolute URL or root-relative path" },
);

export const measureKindSchema = z.enum([
  "context_switch",
  "utterance",
  "spoken_word",
  "time_segment",
  "sentiment",
]);

export const measureCategorySchema = z.enum([
  "physical",
  "cognitive",
  "time",
  "sentiment",
]);

export const normalizationSchema = z.enum([
  "per_minute",
  "neg_density",
  "raw_minutes",
]);

const measureBaseSchema = z.object({
  id: z.string().min(1),
  category: measureCategorySchema,
  t_start_ms: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  source: z.enum(["video_analysis", "telemetry", "manual"]),
  provider_id: z.string().min(1),
  provider_version: z.string().min(1),
});

const wordTimingSchema = z.object({
  w: z.string().min(1),
  t0: z.number().int().nonnegative(),
  t1: z.number().int().nonnegative(),
});

const utteranceMeasureSchema = measureBaseSchema.extend({
  kind: z.literal("utterance"),
  category: z.literal("physical"),
  t_end_ms: z.number().int().nonnegative(),
  value_num: z.null(),
  value_text: z.string().min(1),
  unit: z.null(),
  payload: z.object({
    text: z.string().min(1),
    words: z.array(wordTimingSchema).min(1),
  }),
});

const sentimentMeasureSchema = measureBaseSchema.extend({
  kind: z.literal("sentiment"),
  category: z.literal("sentiment"),
  t_end_ms: z.number().int().nonnegative(),
  value_num: z.number().min(-1).max(1),
  value_text: z.null(),
  unit: z.literal("score"),
  payload: z.record(z.string(), z.unknown()),
});

const contextSwitchMeasureSchema = measureBaseSchema.extend({
  kind: z.literal("context_switch"),
  category: z.literal("cognitive"),
  t_end_ms: z.null(),
  value_num: z.null(),
  value_text: z.null(),
  unit: z.null(),
  payload: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
  }),
});

const spokenWordMeasureSchema = measureBaseSchema.extend({
  kind: z.literal("spoken_word"),
  category: z.literal("physical"),
  t_end_ms: z.number().int().nonnegative(),
  value_num: z.number().int().nonnegative(),
  value_text: z.null(),
  unit: z.literal("words"),
  payload: z.record(z.string(), z.unknown()),
});

const timeSegmentMeasureSchema = measureBaseSchema.extend({
  kind: z.literal("time_segment"),
  category: z.literal("time"),
  t_end_ms: z.number().int().nonnegative(),
  value_num: z.number().int().nonnegative(),
  value_text: z.null(),
  unit: z.literal("ms"),
  payload: z.object({
    segment_id: uuidSchema,
  }),
});

export const measureSchema = z.discriminatedUnion("kind", [
  contextSwitchMeasureSchema,
  utteranceMeasureSchema,
  spokenWordMeasureSchema,
  timeSegmentMeasureSchema,
  sentimentMeasureSchema,
]);

export const reportPayloadSchema = z.object({
  contract_version: z.literal(1),
  run: z.object({
    id: uuidSchema,
    video_id: uuidSchema,
    status: z.enum(["succeeded", "partial"]),
    pipeline_version: z.string().min(1),
    finished_at: isoDateTimeSchema,
    warnings: z.array(z.object({
      code: z.string().min(1),
      message: z.string().min(1),
    })),
  }),
  video: z.object({
    id: uuidSchema,
    title: z.string().min(1),
    duration_ms: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    has_audio: z.boolean(),
    playback_url: rootRelativeOrAbsoluteUrlSchema,
  }),
  task: z.object({
    id: uuidSchema,
    name: z.string().min(1),
  }).nullable(),
  segments: z.array(z.object({
    id: uuidSchema,
    parent_segment_id: uuidSchema.nullable(),
    name: z.string().min(1),
    t_start_ms: z.number().int().nonnegative(),
    t_end_ms: z.number().int().nonnegative(),
    source: z.enum(["audio_cue", "scene_boundary", "llm", "manual"]),
  })),
  measures: z.array(measureSchema),
  score: z.object({
    profile: z.object({
      id: uuidSchema,
      name: z.string().min(1),
      weights: z.partialRecord(measureKindSchema, z.number().min(0)),
      normalization: z.partialRecord(measureKindSchema, normalizationSchema),
    }),
    components: z.object({
      physical: z.number().min(0).max(100),
      cognitive: z.number().min(0).max(100),
      time: z.number().min(0).max(100),
      sentiment: z.number().min(0).max(100),
    }),
    total: z.number().min(0).max(100),
    breakdown: z.array(z.object({
      kind: measureKindSchema,
      raw: z.number().nonnegative(),
      normalized: z.number().min(0).max(100),
      weight: z.number().min(0),
      contribution: z.number().min(0),
    })),
  }),
});

export type MeasureKind = z.infer<typeof measureKindSchema>;
export type MeasureCategory = z.infer<typeof measureCategorySchema>;
export type Normalization = z.infer<typeof normalizationSchema>;
export type ReportMeasure = z.infer<typeof measureSchema>;
export type ReportPayload = z.infer<typeof reportPayloadSchema>;
export type ReportVideo = ReportPayload["video"];
export type WeightProfile = ReportPayload["score"]["profile"];
export type ScoreBlock = ReportPayload["score"];
