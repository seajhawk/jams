import { expect, test } from "@playwright/test"
import path from "node:path"

import { expectAppReady, signInE2eUser } from "./helpers"

const fixturePath = path.resolve(process.cwd(), "../../fixtures/e2e-tiny.mp4")

test("files a session under project > goal > journey with a participant and variant", async ({
  page,
}) => {
  test.setTimeout(180_000)
  const id = crypto.randomUUID().slice(0, 8)
  const names = {
    project: `E2E product ${id}`,
    goal: `Get something done ${id}`,
    journey: `The quick way ${id}`,
    participant: `P-${id}`,
    title: `Journey session ${id}`,
  }

  await signInE2eUser(page)
  await page.goto("/projects")
  await expectAppReady(page)

  // Build the hierarchy through the API the page uses, then find it in the UI.
  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data })
    expect(response.status(), await response.text()).toBe(201)
    return response.json()
  }
  const { project } = await post("/api/projects", { name: names.project })
  const { goal } = await post("/api/goals", { project_id: project.id, name: names.goal })
  const { task: journey } = await post("/api/tasks", { goal_id: goal.id, name: names.journey })

  await page.reload()
  await expect(page.getByRole("link", { name: names.project })).toBeVisible()
  await expect(page.getByText(names.goal)).toBeVisible()
  await page.getByRole("link", { name: new RegExp(names.journey) }).click()

  await page.waitForURL(`**/journeys/${journey.id}`)
  // Client-rendered after its summary loads; allow for a busy CI runner (the worker may be processing).
  await expect(page.getByRole("heading", { name: names.journey })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("No sessions yet.")).toBeVisible()

  // "Add a session" opens the upload dialog with this journey already chosen.
  await page.getByRole("button", { name: "Add a session" }).click()
  await page.waitForURL(/\/library\?upload=1&journey=/)
  await page.getByTestId("upload-file-input").first().setInputFiles(fixturePath)
  await page.getByLabel("Title").fill(names.title)
  await expect(page.getByLabel("Journey", { exact: true })).toHaveValue(journey.id)
  await page.getByLabel(/Participant/).fill(names.participant)
  await page.getByLabel("Cohorts for the new participant").fill("Beginner")
  await page.getByLabel(/Variant/).fill("B")
  await page.getByRole("button", { name: "Upload", exact: true }).click()
  await expect(page.getByText("Video uploaded")).toBeVisible({ timeout: 60_000 })

  // The journey page lists the session with its participant, cohort and variant.
  await page.goto(`/journeys/${journey.id}`)
  const row = page.getByRole("listitem").filter({ hasText: names.title })
  await expect(row).toBeVisible()
  await expect(row.getByText(names.participant)).toBeVisible()
  await expect(row.getByText("beginner", { exact: true })).toBeVisible()
  await expect(row.getByText("B", { exact: true })).toBeVisible()

  // The session page places it in the hierarchy.
  await row.getByRole("link", { name: names.title }).click()
  await expect(page.getByRole("heading", { name: names.title })).toBeVisible()
  const crumbs = page.getByRole("navigation").filter({ hasText: names.journey })
  await expect(crumbs.getByRole("link", { name: names.project })).toBeVisible()
  await expect(crumbs.getByText(names.goal)).toBeVisible()
})
