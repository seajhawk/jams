import { describe, expect, it } from "vitest"

import {
  analysisConfigJsonSchema,
  analysisConfigSchema,
  formatAnalysisConfigError,
} from "@/lib/analysis-config"

describe("analysis config schema", () => {
  it("fills canonical defaults", () => {
    const config = analysisConfigSchema.parse({})

    expect(config).toEqual({
      probe: { enabled: true },
      context_switch: { enabled: true, detector_impl: "adaptive" },
      transcription: { enabled: true },
      sentiment: { enabled: true, fallback: "none" },
      segmentation: { enabled: true, extra_cues: [] },
      llm_labeling: { enabled: false },
    })
  })

  it("keeps v1 dependency providers immutable-on", () => {
    const result = analysisConfigSchema.safeParse({
      probe: { enabled: false },
      transcription: { enabled: false },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      const message = formatAnalysisConfigError(result.error)
      expect(message).toContain("probe.enabled")
      expect(message).toContain("transcription.enabled")
    }
  })

  it("exports a displayable JSON Schema", () => {
    expect(analysisConfigJsonSchema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
    })
  })
})
