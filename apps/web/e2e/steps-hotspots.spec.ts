import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"

import { expectAppReady, signInE2eUser } from "./helpers"

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"

test("finds the step where people struggle and plays those moments", async ({ page }) => {
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
  const { project } = await post("/api/projects", { name: `Steps product ${id}` })
  const { goal } = await post("/api/goals", { project_id: project.id, name: `Set it up ${id}` })
  const { task: journey } = await post("/api/tasks", {
    goal_id: goal.id,
    name: `Setup wizard ${id}`,
    steps: ["Sign in", "Configure settings"],
  })

  try {
    const [profile] = await db`
      select id from weight_profiles where org_id = ${orgId} and is_default order by created_at limit 1`
    const profileId =
      profile?.id ??
      (
        await db`insert into weight_profiles (org_id, name, weights, normalization, is_default)
                 values (${orgId}, 'Default', '{}'::jsonb, '{}'::jsonb, true) returning id`
      )[0].id
    for (const [index, frustrated] of [true, true, false].entries()) {
      const [video] = await db`
        insert into videos (org_id, task_id, title, blob_path, uploaded_by, status, duration_ms)
        values (${orgId}, ${journey.id}, ${`Setup session ${index}`}, ${`e2e/${crypto.randomUUID()}`},
                'e2e', 'uploaded', 60000) returning id`
      const [run] = await db`
        insert into analysis_runs (org_id, video_id, pipeline_version, status, fingerprint_hash)
        values (${orgId}, ${video.id}, 'e2e', 'succeeded', 'e2e-fingerprint') returning id`
      await db`insert into effort_scores (run_id, profile_id, org_id, physical, cognitive, time,
                                          sentiment, speech, total, breakdown)
               values (${run.id}, ${profileId}, ${orgId}, 0, 0, 0, 0, 0, 50, '{}'::jsonb)`
      await db`insert into segments (org_id, run_id, name, t_start_ms, t_end_ms, source)
               values (${orgId}, ${run.id}, 'Signing in', 0, 20000, 'audio_cue'),
                      (${orgId}, ${run.id}, 'Configuring settings', 20000, 60000, 'audio_cue')`
      if (frustrated) {
        const [utterance] = await db`
          insert into measures (run_id, org_id, kind, category, t_start_ms, value_text, source,
                                provider_id, provider_version)
          values (${run.id}, ${orgId}, 'utterance', 'speech', 41000, 'why will this not save',
                  'video_analysis', 'e2e', '1') returning id`
        await db`
          insert into measures (run_id, org_id, kind, category, t_start_ms, value_num, source,
                                provider_id, provider_version, payload)
          values (${run.id}, ${orgId}, 'sentiment', 'sentiment', 41000, -0.8, 'video_analysis',
                  'e2e', '1', ${db.json({ utterance_measure_id: utterance.id })})`
      }
    }

    await page.goto(`/journeys/${journey.id}`)
    const table = page.getByTestId("hotspot-table")
    const firstRow = table.getByRole("row").nth(1)
    await expect(firstRow).toContainText("Configure settings")
    await expect(firstRow).toContainText("2 of 3")

    await firstRow.getByRole("button", { name: "Play all 2" }).click()
    const player = page.getByTestId("clip-player")
    await expect(player).toContainText("Clip 1 of 2")
    await expect(player).toContainText("why will this not save")
    await expect(player.getByRole("button", { name: "Open in report" })).toHaveAttribute(
      "href",
      /\/reports\/[0-9a-f-]{36}\?t=41000$/
    )
  } finally {
    await db`delete from videos where task_id = ${journey.id}`
    await db`delete from projects where id = ${project.id}`
    await db.end()
  }
})
