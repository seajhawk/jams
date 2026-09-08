import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const adminUrl =
  process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"
const webUrl =
  process.env.DATABASE_URL_WEB ??
  "postgresql://jams_web:jams_web@localhost:5432/jams"

const ORG_A = "org_rls_a"
const ORG_B = "org_rls_b"
const VIDEO_A = "11111111-1111-4111-8111-111111111111"
const VIDEO_B = "22222222-2222-4222-8222-222222222222"
const RUN_A = "33333333-3333-4333-8333-333333333333"
const RUN_B = "44444444-4444-4444-8444-444444444444"
const MEASURE_A = "55555555-5555-4555-8555-555555555555"
const MEASURE_B = "66666666-6666-4666-8666-666666666666"

const admin = postgres(adminUrl, { max: 1, prepare: false })
const web = postgres(webUrl, { max: 1, prepare: false })

async function cleanup() {
  await admin`
    delete from measures
    where id in (${MEASURE_A}, ${MEASURE_B})
  `
  await admin`
    delete from analysis_runs
    where id in (${RUN_A}, ${RUN_B})
  `
  await admin`
    delete from videos
    where id in (${VIDEO_A}, ${VIDEO_B})
  `
  await admin`
    delete from orgs
    where id in (${ORG_A}, ${ORG_B})
  `
}

describe("Postgres RLS tenant isolation", () => {
  beforeAll(async () => {
    await cleanup()
    await admin`
      insert into orgs (id, name)
      values (${ORG_A}, 'RLS Org A'), (${ORG_B}, 'RLS Org B')
    `
    await admin`
      insert into videos (id, org_id, title, blob_path, status, uploaded_by)
      values
        (${VIDEO_A}, ${ORG_A}, 'RLS Video A', 'videos/org_rls_a/video.mp4', 'uploaded', 'user_rls'),
        (${VIDEO_B}, ${ORG_B}, 'RLS Video B', 'videos/org_rls_b/video.mp4', 'uploaded', 'user_rls')
    `
    await admin`
      insert into analysis_runs (id, org_id, video_id, pipeline_version, status, stage, progress_pct)
      values
        (${RUN_A}, ${ORG_A}, ${VIDEO_A}, 'rls-test', 'succeeded', 'done', 100),
        (${RUN_B}, ${ORG_B}, ${VIDEO_B}, 'rls-test', 'succeeded', 'done', 100)
    `
    await admin`
      insert into measures (
        id, org_id, run_id, kind, category, t_start_ms, t_end_ms, value_num,
        value_text, unit, confidence, source, provider_id, provider_version, payload
      )
      values
        (${MEASURE_A}, ${ORG_A}, ${RUN_A}, 'context_switch', 'cognitive', 1000, null, null,
          null, null, 1, 'video_analysis', 'rls-test', '1', '{}'::jsonb),
        (${MEASURE_B}, ${ORG_B}, ${RUN_B}, 'context_switch', 'cognitive', 2000, null, null,
          null, null, 1, 'video_analysis', 'rls-test', '1', '{}'::jsonb)
    `
  })

  afterAll(async () => {
    await cleanup()
    await Promise.all([admin.end(), web.end()])
  })

  it("filters deliberately unscoped selects to the transaction org", async () => {
    const rows = await web.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${ORG_A}, true)`
      const videos = await tx`
        select id, org_id
        from videos
        order by title
      `
      const measures = await tx`
        select id, org_id
        from measures
        order by t_start_ms
      `
      return { videos, measures }
    })

    expect(rows.videos).toEqual([{ id: VIDEO_A, org_id: ORG_A }])
    expect(rows.measures).toEqual([{ id: MEASURE_A, org_id: ORG_A }])
  })

  it("returns no tenant rows when app.org_id is unset", async () => {
    const videos = await web`
      select id, org_id
      from videos
      order by title
    `
    const measures = await web`
      select id, org_id
      from measures
      order by t_start_ms
    `

    expect(videos).toEqual([])
    expect(measures).toEqual([])
  })

  it("rejects an insert for another tenant", async () => {
    await expect(web.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${ORG_A}, true)`
      await tx`
        insert into videos (org_id, title, blob_path, status, uploaded_by)
        values (${ORG_B}, 'Forbidden', 'forbidden.mp4', 'uploaded', 'user_rls')
      `
    })).rejects.toMatchObject({ code: "42501" })
  })

  it("cannot update another tenant's video", async () => {
    const rows = await web.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${ORG_A}, true)`
      return tx`
        update videos set title = 'Forbidden'
        where id = ${VIDEO_B} returning id
      `
    })
    expect(rows).toEqual([])
    const [video] = await admin`select title from videos where id = ${VIDEO_B}`
    expect(video.title).toBe('RLS Video B')
  })
})
