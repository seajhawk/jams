import { z } from "zod"

const immutableEnabledProviderSchema = z
  .object({
    enabled: z
      .literal(true)
      .default(true)
      .describe(
        "Immutable for v1 because downstream providers depend on this output."
      ),
  })
  .strict()

const configurableProviderSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict()

export const analysisConfigSchema = z
  .object({
    probe: immutableEnabledProviderSchema.default({ enabled: true }),
    context_switch: immutableEnabledProviderSchema
      .extend({
        detector_impl: z.enum(["adaptive", "dhash"]).default("adaptive"),
      })
      .default({ enabled: true, detector_impl: "adaptive" }),
    transcription: immutableEnabledProviderSchema.default({ enabled: true }),
    sentiment: configurableProviderSchema
      .extend({
        // Worker registry ids (worker/src/jams_worker/providers/sentiment_models.py). Omitted =
        // the worker's default model. "remote" is configured on the worker by environment only.
        model: z.enum(["roberta-3class", "sst2", "vader", "remote"]).optional(),
        fallback: z.enum(["none", "vader"]).default("none"),
      })
      .default({ enabled: true, fallback: "none" }),
    segmentation: configurableProviderSchema
      .extend({
        extra_cues: z.array(z.string().trim().min(1)).default([]),
      })
      .default({ enabled: true, extra_cues: [] }),
    llm_labeling: z
      .object({
        enabled: z.boolean().default(false),
      })
      .strict()
      .default({ enabled: false }),
  })
  .strict()

export type AnalysisConfig = z.infer<typeof analysisConfigSchema>

export const defaultAnalysisConfig: AnalysisConfig = analysisConfigSchema.parse({})

export const analysisConfigJsonSchema = z.toJSONSchema(analysisConfigSchema, {
  target: "draft-7",
})

export function parseAnalysisConfig(input: unknown): AnalysisConfig {
  return analysisConfigSchema.parse(input)
}

export function formatAnalysisConfigError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "config"
      return `${path}: ${issue.message}`
    })
    .join("\n")
}
