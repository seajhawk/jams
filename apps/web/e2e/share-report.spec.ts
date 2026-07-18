import { expect, test } from "@playwright/test"

import { dockerExec, expectAppReady, signInE2eUser, sqlLiteral } from "./helpers"

const RUN_ID = "f6a00000-e2e0-4000-8000-000000000001"
const VIDEO_ID = "f6a00000-e2e0-4000-8000-000000000002"
const PROFILE_ID = "f6a00000-e2e0-4000-8000-000000000003"
const TASK_ID = "f6a00000-e2e0-4000-8000-000000000004"
const SEG_ID = "f6a00000-e2e0-4000-8000-000000000010"
const UTT_ID = "f6a00000-e2e0-4000-8000-000000000020"

async function psql(sql: string) {
  return dockerExec([
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "jams",
    "-d",
    "jams",
    "-At",
    "-F",
    "|",
    "-c",
    sql,
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
  const blobPath = `${orgId}/${VIDEO_ID}/original.mp4`
  const words = JSON.stringify({
    words: [
      { w: "Shared", t0: 1000, t1: 1500 },
      { w: "report", t0: 1600, t1: 2100 },
    ],
  })

  await psql(`
    insert into tasks (id, org_id, name)
    values (${sqlLiteral(TASK_ID)}, ${sqlLiteral(orgId)}, 'E2E Share Report Task')
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into videos (id, org_id, task_id, title, blob_path, duration_ms, width, height, has_audio, status, uploaded_by)
    values (
      ${sqlLiteral(VIDEO_ID)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(TASK_ID)},
      'E2E Share Report Video',
      ${sqlLiteral(blobPath)},
      60000, 1280, 720, true, 'uploaded', 'user_e2e'
    )
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into analysis_runs (id, org_id, video_id, pipeline_version, status, stage, progress_pct, completed_at)
    values (
      ${sqlLiteral(RUN_ID)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(VIDEO_ID)},
      'f6a-e2e.1',
      'succeeded', 'finalize', 100,
      now()
    )
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into segments (id, org_id, run_id, name, t_start_ms, t_end_ms, source)
    values (${sqlLiteral(SEG_ID)}, ${sqlLiteral(orgId)}, ${sqlLiteral(RUN_ID)}, 'Shared segment', 0, 60000, 'audio_cue')
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into measures (id, org_id, run_id, kind, category, t_start_ms, t_end_ms, value_text, unit, confidence, source, provider_id, provider_version, payload)
    values (
      ${sqlLiteral(UTT_ID)}, ${sqlLiteral(orgId)}, ${sqlLiteral(RUN_ID)},
      'utterance', 'speech', 1000, 3000, 'Shared report', null, 0.95,
      'video_analysis', 'faster_whisper', '1.0.0', ${sqlLiteral(words)}::jsonb
    )
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into weight_profiles (id, org_id, name, weights, normalization, is_default)
    values (
      ${sqlLiteral(PROFILE_ID)},
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
  await psql(`delete from share_links where run_id = ${sqlLiteral(RUN_ID)};`)
  await psql(`delete from analysis_runs where id = ${sqlLiteral(RUN_ID)};`)
  await psql(`delete from videos where id = ${sqlLiteral(VIDEO_ID)};`)
  await psql(`delete from tasks where id = ${sqlLiteral(TASK_ID)};`)
  await psql(`delete from weight_profiles where id = ${sqlLiteral(PROFILE_ID)};`)
}

test.describe("shared reports", () => {
  test.beforeAll(async () => {
    const orgId = await getE2eOrgId()
    await cleanupFixture()
    await seedFixture(orgId)
  })

  test.afterAll(async () => {
    await cleanupFixture()
  })

  test("creates, opens, and revokes a shared report link", async ({ browser, page }) => {
    test.setTimeout(60_000)

    await signInE2eUser(page)
    await page.goto(`/reports/${RUN_ID}`)
    await expectAppReady(page)

    await page.getByRole("button", { name: "Share" }).click()
    await page.getByRole("button", { name: "Create link" }).click()
    const shareUrl = await page.getByTestId("created-share-url").inputValue()
    expect(shareUrl).toContain("/share/")

    const sharedContext = await browser.newContext()
    const sharedPage = await sharedContext.newPage()
    const sharedResponse = await sharedPage.goto(shareUrl)
    expect(sharedResponse?.status()).toBe(200)
    await expect(sharedPage.getByText("Shared report").first()).toBeVisible()
    await expect(sharedPage.getByTestId("score-dial")).toBeVisible()
    await expect(sharedPage.getByText("Save as org default")).toHaveCount(0)

    await page.getByRole("button", { name: "Revoke share link" }).click()
    await expect(page.getByText("Revoked")).toBeVisible()

    const revokedResponse = await sharedPage.goto(shareUrl)
    expect(revokedResponse?.status()).toBe(404)
    await sharedContext.close()
  })
})
