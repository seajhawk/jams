import { describe, expect, it } from "vitest";

import demoReport from "../../../../fixtures/demo-report.v1.json";
import { score, normalize } from "@/lib/effort-score";
import { reportPayloadSchema, type ReportMeasure } from "@/lib/report-contract";

const payload = reportPayloadSchema.parse(demoReport);
const wordCount = (text: string) => text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g)?.length ?? 0;

describe("report payload contract", () => {
  it("parses the demo report fixture", () => {
    expect(payload.contract_version).toBe(1);
    expect(payload.run.warnings).toEqual([]);
    expect(payload.video.playback_url).toBe("/demo.mp4");
  });

  it("keeps measures sorted by start timestamp", () => {
    payload.measures.reduce((previousStart, measure) => {
      expect(measure.t_start_ms).toBeGreaterThanOrEqual(previousStart);
      return measure.t_start_ms;
    }, 0);
  });

  it("keeps all measure timestamps inside the video duration", () => {
    for (const measure of payload.measures) {
      expect(measure.t_start_ms).toBeGreaterThanOrEqual(0);
      expect(measure.t_start_ms).toBeLessThanOrEqual(payload.video.duration_ms);

      if (measure.t_end_ms !== null) {
        expect(measure.t_end_ms).toBeLessThanOrEqual(payload.video.duration_ms);
      }
    }
  });

  it("keeps sentiment and utterance measures as positive spans", () => {
    const spanningKinds: Array<ReportMeasure["kind"]> = ["sentiment", "utterance"];

    for (const measure of payload.measures) {
      if (spanningKinds.includes(measure.kind)) {
        expect(measure.t_end_ms).not.toBeNull();
        expect(measure.t_end_ms).toBeGreaterThan(measure.t_start_ms);
      }
    }
  });

  it("matches spoken-word counts to utterance text", () => {
    const utterances = new Map(
      payload.measures
        .filter((measure) => measure.kind === "utterance")
        .map((measure) => [measure.id.replace("u-", ""), measure.payload.text]),
    );

    for (const measure of payload.measures) {
      if (measure.kind === "spoken_word") {
        const utteranceText = utterances.get(measure.id.replace("w-", ""));

        expect(utteranceText).toBeDefined();
        expect(measure.value_num).toBe(wordCount(utteranceText ?? ""));
      }
    }
  });
});

describe("effort score", () => {
  it("recomputes the fixture score block exactly", () => {
    const normalized = normalize(
      payload.measures,
      payload.video,
      payload.score.profile.normalization,
    );
    const recomputed = score(normalized, payload.score.profile.weights);

    expect(recomputed).toEqual({
      components: payload.score.components,
      total: payload.score.total,
      breakdown: payload.score.breakdown,
    });
  });

  it("changes total according to the weighted-mean formula", () => {
    const normalized = normalize(
      payload.measures,
      payload.video,
      payload.score.profile.normalization,
    );
    const weights = {
      ...payload.score.profile.weights,
      sentiment: (payload.score.profile.weights.sentiment ?? 0) * 2,
    };
    const recomputed = score(normalized, weights);

    expect(recomputed.total).toBe(57);
    expect(recomputed.breakdown.find((item) => item.kind === "sentiment")?.contribution)
      .toBe(33.1);
  });

  it("drops zero-weight kinds from score output", () => {
    const normalized = normalize(
      payload.measures,
      payload.video,
      payload.score.profile.normalization,
    );
    const recomputed = score(normalized, {
      ...payload.score.profile.weights,
      context_switch: 0,
    });

    expect(recomputed.breakdown.map((item) => item.kind)).not.toContain("context_switch");
    expect(recomputed.components.cognitive).toBe(0);
    expect(recomputed.total).toBe(53);
  });
});
