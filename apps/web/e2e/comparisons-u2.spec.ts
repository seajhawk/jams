import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import postgres from "postgres"

import { expectAppReady, signInE2eUser } from "./helpers"

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"

/**
 * Finished analyses come from the worker, so this seeds them directly (sessions, runs on one
 * scoring definition, and default-profile scores), the way the pipeline spec cleans up.
 */
async function seedSessions(
  db: postgres.Sql,
  orgId: string,
  journeyId: string,
  totals: number[],
  variantId: string | null = null
) {
  const [profile] = await db`
    select id from weight_profiles where org_id = ${orgId} and is_default order by created_at limit 1`
  const profileId =
    profile?.id ??
    (
      await db`insert into weight_profiles (org_id, name, weights, normalization, is_default)
               values (${orgId}, 'Default', '{}'::jsonb, '{}'::jsonb, true) returning id`
    )[0].id
  for (const [index, total] of totals.entries()) {
    const [video] = await db`
      insert into videos (org_id, task_id, variant_id, title, blob_path, uploaded_by, status)
      values (${orgId}, ${journeyId}, ${variantId}, ${`seeded ${total} ${index}`},
              ${`e2e/${crypto.randomUUID()}`}, 'e2e', 'uploaded')
      returning id`
    const [run] = await db`
      insert into analysis_runs (org_id, video_id, pipeline_version, status, fingerprint_hash)
      values (${orgId}, ${video.id}, 'e2e', 'succeeded', 'e2e-fingerprint') returning id`
    await db`
      insert into effort_scores (run_id, profile_id, org_id, physical, cognitive, time, sentiment,
                                 speech, total, breakdown)
      values (${run.id}, ${profileId}, ${orgId}, 0, 0, 0, 0, 0, ${total}, '{}'::jsonb)`
  }
}

test("compares variants of a journey and ranks the journeys of a goal", async ({ page }) => {
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
  const { project } = await post("/api/projects", { name: `Compare product ${id}` })
  const { goal } = await post("/api/goals", { project_id: project.id, name: `Deploy my app ${id}` })
  const { task: portal } = await post("/api/tasks", { goal_id: goal.id, name: `Portal ${id}` })
  const { task: cli } = await post("/api/tasks", { goal_id: goal.id, name: `CLI ${id}` })
  const { variant: variantA } = await post("/api/variants", { task_id: portal.id, name: "A" })
  const { variant: variantB } = await post("/api/variants", { task_id: portal.id, name: "B" })

  try {
    await seedSessions(db, orgId, portal.id, [60, 62, 58, 64, 61], variantA.id)
    await seedSessions(db, orgId, portal.id, [40, 42, 38, 44, 41], variantB.id)
    await seedSessions(db, orgId, cli.id, [30, 32, 28, 34, 31])

    // Variants of one journey: B is clearly easier, with the interval stated.
    await page.goto(`/journeys/${portal.id}`)
    await expect(page.getByTestId("compare-verdict")).toContainText(
      "B takes less effort than A: median 20 lower (95% range"
    )

    // Journeys of the goal: CLI is easiest, Portal is compared with it.
    await page.goto(`/goals/${goal.id}`)
    const rows = page.getByTestId("goal-journey")
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText(`CLI ${id}`)
    await expect(rows.nth(1)).toContainText(`Portal ${id}`)
    await expect(rows.nth(1)).toContainText(`takes more effort than CLI ${id}`)
  } finally {
    await db`delete from videos where task_id in (${portal.id}, ${cli.id})`
    await db`delete from projects where id = ${project.id}`
    await db.end()
  }
})
