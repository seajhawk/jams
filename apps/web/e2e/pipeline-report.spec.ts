import { expect, test } from "@playwright/test"
import path from "node:path"

import { reportPayloadSchema } from "../src/lib/report-contract"
import { expectAppReady, signInE2eUser } from "./helpers"

const fixturePath = path.resolve(
  process.cwd(),
  process.env.E2E_PIPELINE_FIXTURE ?? "../../fixtures/e2e-pipeline.mp4",
)
const fixtureTitle = path.basename(fixturePath, path.extname(fixturePath))
const narrated = process.env.E2E_PIPELINE_NARRATED === "1"

type AnalysisResponse = {
  analysis: { id: string; video_id: string; status: string }
}

test.describe("real upload to worker report", () => {
  test.skip(
    process.env.JAMS_RUN_PIPELINE_E2E !== "1",
    "Set JAMS_RUN_PIPELINE_E2E=1 to run with the local worker",
  )

  test(`uploads the ${narrated ? "narrated" : "silent"} fixture, processes it, and deep-links to a cut`, async ({
    page,
  }) => {
    test.setTimeout(240_000)

    await signInE2eUser(page)
    await page.goto("/library")
    await expectAppReady(page)

    await page.getByRole("button", { name: "Upload journey" }).first().click()
    await page.getByTestId("upload-file-input").setInputFiles(fixturePath)
    await expect(page.getByLabel("Title")).toHaveValue(fixtureTitle)
    await page.getByRole("button", { name: "Upload" }).click()
    await expect(page.getByText("Video uploaded")).toBeVisible({ timeout: 30_000 })

    const card = page
      .getByTestId("video-card")
      .filter({ has: page.getByText(fixtureTitle, { exact: true }) })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByRole("button", { name: `Open ${fixtureTitle}` }).click()
    await page.waitForURL(/\/library\/[0-9a-f-]{36}$/)
    const videoId = page.url().split("/").pop()!

    await expect(page.getByRole("heading", { name: fixtureTitle })).toBeVisible()
    const analyzeResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/analyses") &&
        response.request().method() === "POST",
    )
    await page.getByRole("button", { name: "Analyze", exact: true }).click()
    const analyzeResponse = await analyzeResponsePromise
    expect(analyzeResponse.status()).toBe(201)
    const analysisBody = (await analyzeResponse.json()) as AnalysisResponse
    const runId = analysisBody.analysis.id
    expect(analysisBody.analysis.video_id).toBe(videoId)

    // Wait for completion first so an incorrect terminal status fails promptly.
    await expect(page.getByRole("link", { name: /View report/ }).last()).toBeVisible({
      timeout: 180_000,
    })
    if (!narrated) {
      await expect(page.getByText("Partial results available.")).toBeVisible()
    }

    const reportHref = await page
      .getByRole("link", { name: /View report/ })
      .last()
      .getAttribute("href")
    expect(reportHref).toBe(`/reports/${runId}`)

    const report = reportPayloadSchema.parse(
      await page.evaluate(async (id) => {
        const response = await fetch(`/api/analyses/${id}/report`)
        if (!response.ok) throw new Error(`report request failed: ${response.status}`)
        const body = await response.json()
        return body.payload
      }, runId),
    )

    expect(report.run.id).toBe(runId)
    expect(report.run.video_id).toBe(videoId)
    expect(report.run.status).toBe(narrated ? "succeeded" : "partial")
    expect(report.video.id).toBe(videoId)
    expect(report.video.title).toBe(fixtureTitle)
    expect(report.video.duration_ms).toBeGreaterThanOrEqual(11_750)
    expect(report.video.duration_ms).toBeLessThanOrEqual(12_250)
    expect(report.video.has_audio).toBe(narrated)
    if (narrated) {
      expect(report.run.warnings).toHaveLength(0)
    } else {
      expect(report.run.warnings.some((warning) => warning.code === "no_audio")).toBe(true)
    }

    const switches = report.measures
      .filter((measure) => measure.kind === "context_switch")
      .sort((a, b) => a.t_start_ms - b.t_start_ms)
    expect(switches).toHaveLength(2)
    expect(Math.abs(switches[0].t_start_ms - 4_000)).toBeLessThanOrEqual(250)
    expect(Math.abs(switches[1].t_start_ms - 8_000)).toBeLessThanOrEqual(250)
    expect(report.segments.length).toBeGreaterThan(0)
    expect(
      report.measures.filter((measure) => measure.kind === "time_segment").length,
    ).toBeGreaterThan(0)
    expect(Number.isFinite(report.score.total)).toBe(true)
    if (narrated) {
      const utterances = report.measures.filter((measure) => measure.kind === "utterance")
      const words = report.measures.filter((measure) => measure.kind === "spoken_word")
      const sentiments = report.measures.filter((measure) => measure.kind === "sentiment")
      expect(utterances.length).toBeGreaterThan(0)
      expect(words.length).toBeGreaterThan(0)
      expect(sentiments.length).toBeGreaterThan(0)
      const firstWord = utterances
        .flatMap((measure) => measure.payload.words)
        .sort((a, b) => a.t0 - b.t0)[0]
      expect(Math.abs(firstWord.t0 - 4_000)).toBeLessThanOrEqual(250)
      for (const utterance of utterances) {
        expect(utterance.t_start_ms).toBeGreaterThanOrEqual(0)
        expect(utterance.t_end_ms).toBeLessThanOrEqual(report.video.duration_ms)
        for (const word of utterance.payload.words) {
          expect(word.t0).toBeGreaterThanOrEqual(0)
          expect(word.t1).toBeLessThanOrEqual(report.video.duration_ms)
          expect(word.t1).toBeGreaterThanOrEqual(word.t0)
        }
      }
      const transcript = utterances.map((measure) => measure.value_text).join(" ").toLowerCase()
      expect(transcript).toContain("speech")
      expect(transcript).toContain("alignment")
      expect(sentiments.every((measure) => measure.provider_id === "sentiment" && measure.payload.method === "onnx")).toBe(true)
    } else {
      expect(report.measures.some((measure) => measure.kind === "utterance")).toBe(false)
      expect(report.measures.some((measure) => measure.kind === "sentiment")).toBe(false)
    }

    await page.goto(reportHref!)
    if (narrated) {
      await expect(page.getByText("Partial results", { exact: true })).not.toBeVisible()
    } else {
      await expect(page.getByText("Partial results", { exact: true })).toBeVisible()
      await expect(
        page.getByText("No narration audio was available for some segments."),
      ).toBeVisible()
    }
    await expect(page.getByTestId("score-dial")).toBeVisible()
    await expect(page.getByTestId("report-timeline")).toBeVisible()

    await page.waitForFunction(
      () => {
        const video = document.querySelector("video")
        return video !== null && video.readyState >= 1
      },
      undefined,
      { timeout: 15_000 },
    )
    await page.locator("video").first().evaluate((video: HTMLVideoElement) => video.pause())
    await page.getByRole("tab", { name: "Measures" }).click()
    const switchRow = page.locator("tbody tr").filter({ hasText: "context_switch" }).first()
    await expect(switchRow).toBeVisible()
    await switchRow.click()

    const expectedCutMs = switches[0].t_start_ms
    await expect
      .poll(
        async () => {
          const state = await page.locator("video").first().evaluate((video: HTMLVideoElement) => ({
            currentTimeMs: video.currentTime * 1000,
            readyState: video.readyState,
            seeking: video.seeking,
          }))
          return state.seeking || state.readyState < 2
            ? Number.POSITIVE_INFINITY
            : Math.abs(state.currentTimeMs - expectedCutMs)
        },
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(250)

    const playbackMs = await page
      .locator("video")
      .first()
      .evaluate((video: HTMLVideoElement) => video.currentTime * 1000)
    let transcriptPlaybackMs: number | undefined
    if (narrated) {
      const utterance = report.measures.find((measure) => measure.kind === "utterance")
      expect(utterance).toBeDefined()
      await page.getByRole("tab", { name: "Transcript" }).click()
      const transcriptRow = page.getByTestId("transcript-row").first()
      await expect(transcriptRow).toBeVisible()
      // Start away from the target; otherwise a no-op click could pass when the
      // first utterance and the previously selected cut share a timestamp.
      await page.locator("video").first().evaluate((video: HTMLVideoElement) => {
        video.currentTime = 0
      })
      await expect.poll(async () => page.locator("video").first().evaluate(
        (video: HTMLVideoElement) => !video.seeking && video.currentTime < 0.25,
      )).toBe(true)
      await transcriptRow.click()
      const expectedTranscriptMs = utterance!.t_start_ms
      await expect
        .poll(
          async () => {
            const state = await page.locator("video").first().evaluate((video: HTMLVideoElement) => ({
              currentTimeMs: video.currentTime * 1000,
              readyState: video.readyState,
              seeking: video.seeking,
            }))
            return state.seeking || state.readyState < 2
              ? Number.POSITIVE_INFINITY
              : Math.abs(state.currentTimeMs - expectedTranscriptMs)
          },
          { timeout: 5_000 },
        )
        .toBeLessThanOrEqual(250)
      transcriptPlaybackMs = await page
        .locator("video")
        .first()
        .evaluate((video: HTMLVideoElement) => video.currentTime * 1000)
    }

    // Keep the attachment useful in CI while excluding the playback SAS token.
    await test.info().attach("pipeline-report-evidence.json", {
      body: Buffer.from(
        JSON.stringify({
          run: report.run,
          video: {
            id: report.video.id,
            title: report.video.title,
            duration_ms: report.video.duration_ms,
            width: report.video.width,
            height: report.video.height,
            has_audio: report.video.has_audio,
          },
          context_switches: switches.map(({ id, t_start_ms, t_end_ms }) => ({
            id,
            t_start_ms,
            t_end_ms,
          })),
          segment_count: report.segments.length,
          time_segment_count: report.measures.filter(
            (measure) => measure.kind === "time_segment",
          ).length,
          score_total: report.score.total,
          expected_cut_ms: expectedCutMs,
          playback_ms: playbackMs,
          ...(transcriptPlaybackMs === undefined ? {} : {
            first_utterance_ms: report.measures.find((measure) => measure.kind === "utterance")?.t_start_ms,
            transcript_playback_ms: transcriptPlaybackMs,
          }),
        }, null, 2),
      ),
      contentType: "application/json",
    })
  })
})
