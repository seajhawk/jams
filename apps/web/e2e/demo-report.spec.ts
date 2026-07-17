import { expect, test } from "@playwright/test"

import { expectAppReady, signInE2eUser } from "./helpers"

test("signed-in user can inspect the demo report and seek from transcript", async ({
  page,
}) => {
  await signInE2eUser(page)
  await page.goto("/demo/report")
  await expectAppReady(page)

  await expect(page.getByTestId("score-dial")).toBeVisible()
  await expect(page.getByTestId("report-timeline")).toBeVisible()

  const targetRow = page.getByTestId("transcript-row").nth(2)
  await expect(targetRow).toBeVisible()

  const targetMs = Number(await targetRow.getAttribute("data-start-ms"))
  expect(targetMs).toBeGreaterThan(0)

  await targetRow.click()

  const playhead = page.getByTestId("timeline-playhead")
  await expect
    .poll(async () => {
      const x = await playhead.getAttribute("x1")
      return x ? Number(x) : 0
    })
    .toBeGreaterThan(0)
})
