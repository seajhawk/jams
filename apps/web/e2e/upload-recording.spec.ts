import { expect, test } from "@playwright/test"
import path from "node:path"
import { writeFile } from "node:fs/promises"

import { reportPayloadSchema } from "../src/lib/report-contract"
import { expectAppReady, signInE2eUser } from "./helpers"

/**
 * Not a regression test: a driver that submits one recording through the real website, the way
 * a customer does, and saves the finished report for scoring (docs/ACCURACY-PROGRAM.md,
 * component E). Point PLAYWRIGHT_BASE_URL at the local stack or staging.
 *
 *   JAMS_UPLOAD_FILE=<mp4> JAMS_UPLOAD_OUT=<report.json> [JAMS_UPLOAD_TITLE=<title>]
 *
 * A recording already in the library under the same title, whose latest run finished, is reused
 * rather than uploaded again (preview quotas count analyses). Set JAMS_UPLOAD_REUSE=0 to force a
 * fresh upload and analysis.
 */
const uploadFile = process.env.JAMS_UPLOAD_FILE
const reportOut = process.env.JAMS_UPLOAD_OUT

test.describe("submit a recording through the website", () => {
  test.skip(!uploadFile || !reportOut, "Set JAMS_UPLOAD_FILE and JAMS_UPLOAD_OUT")

  test("uploads, analyzes, and saves the report", async ({ page }) => {
    test.setTimeout(30 * 60_000)
    const file = path.resolve(uploadFile!)
    const title = process.env.JAMS_UPLOAD_TITLE ?? path.basename(file, path.extname(file))

    await signInE2eUser(page)
    await page.goto("/library")
    await expectAppReady(page)

    type LibraryVideo = { id: string; title: string; latest_run: { id: string; status: string } | null }
    const library = await page.evaluate(async () => {
      const r = await fetch("/api/videos")
      return ((await r.json()) as { videos: LibraryVideo[] }).videos
    })
    const existing = process.env.JAMS_UPLOAD_REUSE === "0"
      ? undefined
      : library.find((v) => v.title === title && ["succeeded", "partial"].includes(v.latest_run?.status ?? ""))

    let videoId: string
    let runId: string
    if (existing) {
      videoId = existing.id
      runId = existing.latest_run!.id
      console.log(`reusing ${title}: video ${videoId}, run ${runId}`)
    } else {
      await page.getByRole("button", { name: "Upload journey" }).first().click()
      await page.getByTestId("upload-file-input").setInputFiles(file)
      await page.getByLabel("Title").fill(title)
      const createdPromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/videos") && r.request().method() === "POST",
      )
      await page.getByRole("button", { name: "Upload", exact: true }).click()
      const created = await createdPromise
      expect(created.status(), await created.text()).toBe(201)
      videoId = ((await created.json()) as { video_id: string }).video_id
      await expect(page.getByText("Video uploaded")).toBeVisible({ timeout: 10 * 60_000 })

      await page.goto(`/library/${videoId}`)
      await expect(page.getByRole("heading", { name: title })).toBeVisible()
      const analyzePromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/analyses") && r.request().method() === "POST",
      )
      await page.getByRole("button", { name: "Analyze", exact: true }).click()
      const analyze = await analyzePromise
      expect(analyze.status(), await analyze.text()).toBe(201)
      runId = ((await analyze.json()) as { analysis: { id: string } }).analysis.id
    }

    let status = "queued"
    const deadline = Date.now() + 25 * 60_000
    while (Date.now() < deadline) {
      const body = await page.evaluate(async (id) => {
        const r = await fetch(`/api/analyses/${id}`)
        return (await r.json()) as { analysis: { status: string; error_code?: string | null } }
      }, runId)
      status = body.analysis.status
      if (!["queued", "running", "pending", "dispatched"].includes(status)) {
        if (!["succeeded", "partial"].includes(status)) {
          throw new Error(`analysis ${runId} ended ${status}: ${body.analysis.error_code ?? ""}`)
        }
        break
      }
      await page.waitForTimeout(5_000)
    }

    const report = reportPayloadSchema.parse(
      await page.evaluate(async (id) => {
        const r = await fetch(`/api/analyses/${id}/report`)
        if (!r.ok) throw new Error(`report request failed: ${r.status}`)
        return ((await r.json()) as { payload: unknown }).payload
      }, runId),
    )
    const origin = new URL(page.url()).origin
    await writeFile(
      path.resolve(reportOut!),
      `${JSON.stringify({ origin, video_id: videoId, run_id: runId, status, report }, null, 2)}\n`,
    )
    console.log(`report: ${origin}/reports/${runId}  status: ${status}`)
  })
})
