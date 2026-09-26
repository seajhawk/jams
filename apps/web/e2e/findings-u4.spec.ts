import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"

import { expectAppReady, signInE2eUser } from "./helpers"

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"

test("saves a comparison as a finding and shows the portfolio views", async ({ page }) => {
  test.setTimeout(180_000)
  const { orgId } = JSON.parse(
    await readFile(path.join(process.cwd(), ".e2e-user.local.json"), "utf8")
  ) as { orgId: string }
  const id = crypto.randomUUID().slice(0, 8)
  const db = postgres(databaseUrl, { max: 1 })

  await signInE2eUser(page)
  await page.goto("/projects")
  await expectAppReady(page)

  const post = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { data })
    expect(response.status(), await response.text()).toBe(201)
    return response.json()
  }
  const { project } = await post("/api/projects", { name: `Findings product ${id}` })
  const { goal } = await post("/api/goals", { project_id: project.id, name: `Check out ${id}` })
  const { task: journey } = await post("/api/tasks", { goal_id: goal.id, name: `Checkout ${id}` })
  const { variant: a } = await post("/api/variants", { task_id: journey.id, name: "A" })
  const { variant: b } = await post("/api/variants", { task_id: journey.id, name: "B" })

  try {
    const [profile] = await db`
      select id from weight_profiles where org_id = ${orgId} and is_default order by created_at limit 1`
    const profileId =
      profile?.id ??
      (
        await db`insert into weight_profiles (org_id, name, weights, normalization, is_default)
                 values (${orgId}, 'Default', '{}'::jsonb, '{}'::jsonb, true) returning id`
      )[0].id
    for (const [variantId, totals] of [
      [a.id, [60, 62, 58, 64, 61]],
      [b.id, [40, 42, 38, 44, 41]],
    ] as const) {
      for (const total of totals) {
        const [video] = await db`
          insert into videos (org_id, task_id, variant_id, title, blob_path, uploaded_by, status)
          values (${orgId}, ${journey.id}, ${variantId}, ${`Checkout ${total}`},
                  ${`e2e/${crypto.randomUUID()}`}, 'e2e', 'uploaded') returning id`
        const [run] = await db`
          insert into analysis_runs (org_id, video_id, pipeline_version, status, fingerprint_hash)
          values (${orgId}, ${video.id}, 'e2e', 'succeeded', 'e2e-fingerprint') returning id`
        await db`insert into effort_scores (run_id, profile_id, org_id, physical, cognitive, time,
                                            sentiment, speech, total, breakdown)
                 values (${run.id}, ${profileId}, ${orgId}, 0, 0, 0, 0, 0, ${total}, '{}'::jsonb)`
      }
    }

    // Save the comparison from the journey page.
    await page.goto(`/journeys/${journey.id}`)
    await expect(page.getByTestId("compare-verdict")).toContainText("B takes less effort than A")
    await page.getByRole("button", { name: "Save as finding" }).first().click()
    await page.getByLabel("Finding title").fill(`B wins ${id}`)
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("link", { name: "Findings", exact: true }).last()).toBeVisible()

    // It is listed, frozen, and still holds.
    await page.goto("/findings")
    const finding = page.getByTestId("finding").filter({ hasText: `B wins ${id}` })
    await expect(finding).toContainText("B takes less effort than A: median 20 lower")
    await expect(finding).toContainText("Still holds")

    // Portfolio views.
    await page.goto(`/projects/${project.id}`)
    await expect(page.getByTestId("project-heatmap")).toContainText(`Checkout ${id}`)
    await page.goto("/projects")
    await expect(page.getByTestId("workspace-summary")).toContainText(`Findings product ${id}`)
  } finally {
    await db`delete from findings where title = ${`B wins ${id}`}`
    await db`delete from videos where task_id = ${journey.id}`
    await db`delete from projects where id = ${project.id}`
    await db.end()
  }
})
