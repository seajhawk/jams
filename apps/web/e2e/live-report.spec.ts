import { expect, test } from "@playwright/test"

import { dockerExec, expectAppReady, signInE2eUser, sqlLiteral } from "./helpers"

// Fixed IDs for the seeded fixture so we can clean up deterministically
const FIXTURE_RUN_ID = "f4b00000-e2e0-4000-8000-000000000001"
const FIXTURE_VIDEO_ID = "f4b00000-e2e0-4000-8000-000000000002"
const FIXTURE_PROFILE_ID = "f4b00000-e2e0-4000-8000-000000000003"
const FIXTURE_TASK_ID = "f4b00000-e2e0-4000-8000-000000000004"
const FIXTURE_SEG_1 = "f4b00000-e2e0-4000-8000-000000000010"
const FIXTURE_SEG_2 = "f4b00000-e2e0-4000-8000-000000000011"
const FIXTURE_UTT_1 = "f4b00000-e2e0-4000-8000-000000000020"
const FIXTURE_UTT_2 = "f4b00000-e2e0-4000-8000-000000000021"
const FIXTURE_UTT_3 = "f4b00000-e2e0-4000-8000-000000000022"

async function psql(sql: string) {
  return dockerExec([
    "compose", "exec", "-T", "postgres",
    "psql", "-U", "jams", "-d", "jams", "-At", "-F", "|", "-c", sql,
  ])
}

async function getE2eOrgId(): Promise<string> {
  const { promises: fs } = await import("node:fs")
  const path = await import("node:path")
  const state = JSON.parse(
    await fs.readFile(path.join(process.cwd(), ".e2e-user.local.json"), "utf8")
  ) as { orgId?: string }
  if (!state.orgId) throw new Error("E2E orgId missing")
  return state.orgId
}

async function seedFixture(orgId: string) {
  const blobPath = `${orgId}/${FIXTURE_VIDEO_ID}/original.mp4`

  await psql(`
    insert into tasks (id, org_id, name)
    values (${sqlLiteral(FIXTURE_TASK_ID)}, ${sqlLiteral(orgId)}, 'E2E Live Report Task')
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into videos (id, org_id, task_id, title, blob_path, duration_ms, width, height, has_audio, status, uploaded_by)
    values (
      ${sqlLiteral(FIXTURE_VIDEO_ID)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(FIXTURE_TASK_ID)},
      'E2E Live Report Video',
      ${sqlLiteral(blobPath)},
      120000, 1920, 1080, true, 'uploaded', 'user_e2e'
    )
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into analysis_runs (id, org_id, video_id, pipeline_version, status, stage, progress_pct, completed_at)
    values (
      ${sqlLiteral(FIXTURE_RUN_ID)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(FIXTURE_VIDEO_ID)},
      'f4b-e2e.1',
      'succeeded', 'finalize', 100,
      now()
    )
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into segments (id, org_id, run_id, name, t_start_ms, t_end_ms, source)
    values
      (${sqlLiteral(FIXTURE_SEG_1)}, ${sqlLiteral(orgId)}, ${sqlLiteral(FIXTURE_RUN_ID)}, 'Introduction', 0, 60000, 'audio_cue'),
      (${sqlLiteral(FIXTURE_SEG_2)}, ${sqlLiteral(orgId)}, ${sqlLiteral(FIXTURE_RUN_ID)}, 'Main task', 60000, 120000, 'scene_boundary')
    on conflict (id) do nothing;
  `)

  const words1 = JSON.stringify({
    words: [
      { w: "Hello", t0: 1000, t1: 1500 },
      { w: "there", t0: 1600, t1: 2000 },
    ],
  })
  const words2 = JSON.stringify({
    words: [
      { w: "Now", t0: 5000, t1: 5400 },
      { w: "navigating", t0: 5500, t1: 6100 },
      { w: "to", t0: 6200, t1: 6400 },
      { w: "settings", t0: 6500, t1: 7000 },
    ],
  })
  const words3 = JSON.stringify({
    words: [
      { w: "Task", t0: 70000, t1: 70400 },
      { w: "complete", t0: 70500, t1: 71000 },
    ],
  })

  await psql(`
    insert into measures (id, org_id, run_id, kind, category, t_start_ms, t_end_ms, value_text, unit, confidence, source, provider_id, provider_version, payload)
    values
      (${sqlLiteral(FIXTURE_UTT_1)}, ${sqlLiteral(orgId)}, ${sqlLiteral(FIXTURE_RUN_ID)},
       'utterance', 'speech', 1000, 4000, 'Hello there', null, 0.95,
       'video_analysis', 'faster_whisper', '1.0.0', ${sqlLiteral(words1)}::jsonb),
      (${sqlLiteral(FIXTURE_UTT_2)}, ${sqlLiteral(orgId)}, ${sqlLiteral(FIXTURE_RUN_ID)},
       'utterance', 'speech', 5000, 9000, 'Now navigating to settings', null, 0.92,
       'video_analysis', 'faster_whisper', '1.0.0', ${sqlLiteral(words2)}::jsonb),
      (${sqlLiteral(FIXTURE_UTT_3)}, ${sqlLiteral(orgId)}, ${sqlLiteral(FIXTURE_RUN_ID)},
       'utterance', 'speech', 70000, 73000, 'Task complete', null, 0.98,
       'video_analysis', 'faster_whisper', '1.0.0', ${sqlLiteral(words3)}::jsonb)
    on conflict (id) do nothing;
  `)

  // Seed the default weight profile (on conflict do nothing so we don't overwrite existing)
  await psql(`
    insert into weight_profiles (id, org_id, name, weights, normalization, is_default)
    values (
      ${sqlLiteral(FIXTURE_PROFILE_ID)},
      ${sqlLiteral(orgId)},
      'Default',
      '{"context_switch":3,"sentiment":4,"spoken_word":1,"time_segment":2}'::jsonb,
      '{"context_switch":"per_minute","sentiment":"neg_density","spoken_word":"per_minute","time_segment":"raw_minutes"}'::jsonb,
      true
    )
    on conflict (org_id, name) do nothing;
  `)
}

async function cleanupFixture() {
  await psql(`delete from analysis_runs where id = ${sqlLiteral(FIXTURE_RUN_ID)};`)
  await psql(`delete from videos where id = ${sqlLiteral(FIXTURE_VIDEO_ID)};`)
  await psql(`delete from tasks where id = ${sqlLiteral(FIXTURE_TASK_ID)};`)
  await psql(`delete from weight_profiles where id = ${sqlLiteral(FIXTURE_PROFILE_ID)};`)
}

test.describe("live report", () => {
  let orgId: string

  test.beforeAll(async () => {
    orgId = await getE2eOrgId()
    await cleanupFixture()
    await seedFixture(orgId)
  })

  test.afterAll(async () => {
    await cleanupFixture()
  })

  test("renders score dial and timeline for a seeded run, and a transcript-row click seeks the player", async ({
    page,
  }) => {
    test.setTimeout(60_000)

    await signInE2eUser(page)
    await page.goto(`/reports/${FIXTURE_RUN_ID}`)
    await expectAppReady(page)

    // Score dial must be visible
    await expect(page.getByTestId("score-dial")).toBeVisible({ timeout: 15_000 })

    // Timeline must be visible
    await expect(page.getByTestId("report-timeline")).toBeVisible()

    // Switch to Transcript tab
    await page.getByRole("tab", { name: "Transcript" }).click()

    // At least one transcript row must appear
    const rows = page.getByTestId("transcript-row")
    await expect(rows.first()).toBeVisible()

    // Click the second transcript row and assert the playhead moves
    const targetRow = rows.nth(1)
    await expect(targetRow).toBeVisible()
    const startMs = Number(await targetRow.getAttribute("data-start-ms"))
    expect(startMs).toBeGreaterThan(0)

    await targetRow.click()

    const playhead = page.getByTestId("timeline-playhead")
    await expect
      .poll(
        async () => {
          const x = await playhead.getAttribute("x1")
          return x ? Number(x) : 0
        },
        { timeout: 5000 }
      )
      .toBeGreaterThan(0)
  })
})
