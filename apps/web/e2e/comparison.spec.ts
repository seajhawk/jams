import { expect, test } from "@playwright/test"

import { dockerExec, expectAppReady, signInE2eUser, sqlLiteral } from "./helpers"

// Fixed IDs for the F7 compare fixture
const CMP_TASK_ID = "f7000000-e2e0-4000-8000-000000000005"
const CMP_VIDEO_A = "f7000000-e2e0-4000-8000-000000000003"
const CMP_VIDEO_B = "f7000000-e2e0-4000-8000-000000000004"
const CMP_RUN_A = "f7000000-e2e0-4000-8000-000000000001"
const CMP_RUN_B = "f7000000-e2e0-4000-8000-000000000002"
const CMP_PROFILE = "f7000000-e2e0-4000-8000-000000000006"
// Run A: 2 segments; Run B: 3 segments (tests positional_partial)
const CMP_SEG_A1 = "f7000000-e2e0-4000-8000-000000000010"
const CMP_SEG_A2 = "f7000000-e2e0-4000-8000-000000000011"
const CMP_SEG_B1 = "f7000000-e2e0-4000-8000-000000000012"
const CMP_SEG_B2 = "f7000000-e2e0-4000-8000-000000000013"
const CMP_SEG_B3 = "f7000000-e2e0-4000-8000-000000000014"

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
    await fs.readFile(path.join(process.cwd(), ".e2e-user.local.json"), "utf8"),
  ) as { orgId?: string }
  if (!state.orgId) throw new Error("E2E orgId missing")
  return state.orgId
}

async function seedFixture(orgId: string) {
  const blobPathA = `${orgId}/${CMP_VIDEO_A}/original.mp4`
  const blobPathB = `${orgId}/${CMP_VIDEO_B}/original.mp4`

  await psql(`
    insert into tasks (id, org_id, name)
    values (${sqlLiteral(CMP_TASK_ID)}, ${sqlLiteral(orgId)}, 'F7 Compare Task')
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into videos (id, org_id, task_id, title, blob_path, duration_ms, width, height, has_audio, status, uploaded_by, subject_label, variant_label)
    values
      (
        ${sqlLiteral(CMP_VIDEO_A)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_TASK_ID)},
        'F7 Compare Video A', ${sqlLiteral(blobPathA)},
        120000, 1920, 1080, true, 'uploaded', 'user_e2e',
        'Participant 1', null
      ),
      (
        ${sqlLiteral(CMP_VIDEO_B)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_TASK_ID)},
        'F7 Compare Video B', ${sqlLiteral(blobPathB)},
        90000, 1920, 1080, true, 'uploaded', 'user_e2e',
        'Participant 2', 'Alt flow'
      )
    on conflict (id) do nothing;
  `)

  await psql(`
    insert into analysis_runs (id, org_id, video_id, pipeline_version, status, stage, progress_pct, completed_at)
    values
      (
        ${sqlLiteral(CMP_RUN_A)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_VIDEO_A)},
        'f7-e2e.1', 'succeeded', 'finalize', 100, now()
      ),
      (
        ${sqlLiteral(CMP_RUN_B)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_VIDEO_B)},
        'f7-e2e.1', 'succeeded', 'finalize', 100, now()
      )
    on conflict (id) do nothing;
  `)

  // Run A: 2 segments
  await psql(`
    insert into segments (id, org_id, run_id, name, t_start_ms, t_end_ms, source)
    values
      (${sqlLiteral(CMP_SEG_A1)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_RUN_A)}, 'Introduction', 0, 60000, 'audio_cue'),
      (${sqlLiteral(CMP_SEG_A2)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_RUN_A)}, 'Main task', 60000, 120000, 'scene_boundary')
    on conflict (id) do nothing;
  `)

  // Run B: 3 segments (extra to test positional_partial)
  await psql(`
    insert into segments (id, org_id, run_id, name, t_start_ms, t_end_ms, source)
    values
      (${sqlLiteral(CMP_SEG_B1)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_RUN_B)}, 'Introduction', 0, 45000, 'audio_cue'),
      (${sqlLiteral(CMP_SEG_B2)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_RUN_B)}, 'Main task', 45000, 80000, 'scene_boundary'),
      (${sqlLiteral(CMP_SEG_B3)}, ${sqlLiteral(orgId)}, ${sqlLiteral(CMP_RUN_B)}, 'Wrap-up', 80000, 90000, 'audio_cue')
    on conflict (id) do nothing;
  `)

  // Seed default weight profile (skip if already exists for this org)
  await psql(`
    insert into weight_profiles (id, org_id, name, weights, normalization, is_default)
    values (
      ${sqlLiteral(CMP_PROFILE)},
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
  await psql(`delete from analysis_runs where id in (${sqlLiteral(CMP_RUN_A)}, ${sqlLiteral(CMP_RUN_B)});`)
  await psql(`delete from videos where id in (${sqlLiteral(CMP_VIDEO_A)}, ${sqlLiteral(CMP_VIDEO_B)});`)
  await psql(`delete from tasks where id = ${sqlLiteral(CMP_TASK_ID)};`)
  await psql(`delete from weight_profiles where id = ${sqlLiteral(CMP_PROFILE)};`)
}

test.describe("comparison page", () => {
  let orgId: string

  test.beforeAll(async () => {
    orgId = await getE2eOrgId()
    await cleanupFixture()
    await seedFixture(orgId)
  })

  test.afterAll(async () => {
    await cleanupFixture()
  })

  test("renders score dials, delta chips, paired segment bars, and tab switch", async ({
    page,
  }) => {
    test.setTimeout(60_000)

    await signInE2eUser(page)
    await page.goto(`/compare?runs=${CMP_RUN_A},${CMP_RUN_B}`)
    await expectAppReady(page)

    // ── Dials ──────────────────────────────────────────────────────────
    await expect(page.getByTestId("compare-dial-a")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("compare-dial-b")).toBeVisible()

    // ── Delta chip (total or component) ────────────────────────────────
    const deltaChips = page.getByTestId("delta-chip")
    await expect(deltaChips.first()).toBeVisible()

    // ── Segment bars ────────────────────────────────────────────────────
    await expect(page.getByTestId("segment-bars")).toBeVisible()
    // Two aligned pairs + 1 unmatched from B
    await expect(page.getByTestId("segment-bar-a-0")).toBeVisible()
    await expect(page.getByTestId("segment-bar-b-0")).toBeVisible()
    await expect(page.getByTestId("segment-bar-a-1")).toBeVisible()
    await expect(page.getByTestId("segment-bar-b-1")).toBeVisible()
    // Unmatched B segment (Wrap-up)
    await expect(page.getByTestId("segment-bar-unmatched-b")).toBeVisible()

    // ── Tab switch: click Run B segment bar → tab B becomes active ─────
    const tabA = page.getByTestId("compare-tab-a")
    const tabB = page.getByTestId("compare-tab-b")

    // Tab A is active initially
    await expect(tabA).toHaveAttribute("aria-selected", "true")

    // Click a B segment bar while on tab A
    await page.getByTestId("segment-bar-b-0").click()

    // Tab B should now be active
    await expect(tabB).toHaveAttribute("aria-selected", "true")
    await expect(tabA).toHaveAttribute("aria-selected", "false")
  })
})
