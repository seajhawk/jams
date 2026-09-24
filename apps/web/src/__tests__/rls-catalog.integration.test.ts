import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * rls.integration.test.ts proves isolation on videos and measures. This proves it for every
 * tenant table, from the catalog, so a new table or a new policy cannot quietly opt out.
 *
 * The trap it guards against: Postgres ORs permissive policies together. One extra policy with
 * USING (true) for the web role silently disables tenant isolation for that table, however
 * careful the org policy next to it is.
 */

const adminUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"
const webUrl =
  process.env.DATABASE_URL_WEB ?? "postgresql://jams_web:jams_web@localhost:5432/jams"

const admin = postgres(adminUrl, { max: 1, prepare: false })
const web = postgres(webUrl, { max: 1, prepare: false })

const ORG_A = "org_rls_catalog_a"
const ORG_B = "org_rls_catalog_b"
const VIDEO_A = "a1111111-1111-4111-8111-111111111111"
const VIDEO_B = "b2222222-2222-4222-8222-222222222222"
const RUN_A = "a3333333-3333-4333-8333-333333333333"
const RUN_B = "b4444444-4444-4444-8444-444444444444"
const TOKEN_A = "A".repeat(43)
const TOKEN_B = "B".repeat(43)

type TableRow = { table_name: string; rls: boolean; forced: boolean }
type PolicyRow = { tablename: string; policyname: string; cmd: string; qual: string | null }

async function tenantTables(): Promise<TableRow[]> {
  return admin<TableRow[]>`
    select c.relname as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'org_id'
      )
    order by c.relname
  `
}

async function cleanup() {
  await admin`delete from share_links where token in (${TOKEN_A}, ${TOKEN_B})`
  await admin`delete from analysis_runs where id in (${RUN_A}, ${RUN_B})`
  await admin`delete from videos where id in (${VIDEO_A}, ${VIDEO_B})`
  await admin`delete from orgs where id in (${ORG_A}, ${ORG_B})`
}

describe("RLS across every tenant table", () => {
  beforeAll(async () => {
    await cleanup()
    await admin`insert into orgs (id, name) values (${ORG_A}, 'Catalog A'), (${ORG_B}, 'Catalog B')`
    await admin`
      insert into videos (id, org_id, title, blob_path, status, uploaded_by) values
        (${VIDEO_A}, ${ORG_A}, 'Catalog A', 'org_rls_catalog_a/a/original.mp4', 'uploaded', 'user_a'),
        (${VIDEO_B}, ${ORG_B}, 'Catalog B', 'org_rls_catalog_b/b/original.mp4', 'uploaded', 'user_b')
    `
    await admin`
      insert into analysis_runs (id, org_id, video_id, pipeline_version, status, stage, progress_pct) values
        (${RUN_A}, ${ORG_A}, ${VIDEO_A}, 'rls-catalog', 'succeeded', 'done', 100),
        (${RUN_B}, ${ORG_B}, ${VIDEO_B}, 'rls-catalog', 'succeeded', 'done', 100)
    `
    await admin`
      insert into share_links (org_id, run_id, token, expires_at, created_by) values
        (${ORG_A}, ${RUN_A}, ${TOKEN_A}, now() + interval '7 days', 'user_a'),
        (${ORG_B}, ${RUN_B}, ${TOKEN_B}, now() + interval '7 days', 'user_b')
    `
  })

  afterAll(async () => {
    await cleanup()
    await Promise.all([admin.end(), web.end()])
  })

  it("enables and forces row-level security on every table that carries org_id", async () => {
    const tables = await tenantTables()

    expect(tables.length).toBeGreaterThanOrEqual(10)
    const unprotected = tables.filter((t) => !t.rls || !t.forced).map((t) => t.table_name)
    expect(unprotected).toEqual([])
  })

  it("gives the web role no policy that lets every row through", async () => {
    const open = await admin<PolicyRow[]>`
      select tablename, policyname, cmd, qual
      from pg_policies
      where schemaname = 'public'
        and permissive = 'PERMISSIVE'
        and ('jams_web' = any(roles) or 'public' = any(roles))
        and (qual is null or btrim(qual) in ('true', '(true)'))
        and cmd in ('SELECT', 'ALL', 'UPDATE', 'DELETE')
    `

    expect(open.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([])
  })

  it("does not show one tenant's share links to another", async () => {
    const visible = await web.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${ORG_A}, true)`
      return tx<{ token: string }[]>`select token from share_links where token in (${TOKEN_A}, ${TOKEN_B})`
    })

    expect(visible.map((row) => row.token)).toEqual([TOKEN_A])
  })

  it("shows no share links at all without a tenant or a presented token", async () => {
    const visible = await web<{ token: string }[]>`
      select token from share_links where token in (${TOKEN_A}, ${TOKEN_B})
    `

    expect(visible).toEqual([])
  })

  it("resolves exactly the presented token for the public share page, and nothing else", async () => {
    const visible = await web.begin(async (tx) => {
      await tx`select set_config('app.share_token', ${TOKEN_B}, true)`
      return tx<{ token: string; org_id: string }[]>`
        select token, org_id from share_links where token in (${TOKEN_A}, ${TOKEN_B})
      `
    })

    expect(visible).toEqual([{ token: TOKEN_B, org_id: ORG_B }])
  })
})
