import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { findings } from "@/db/schema"
import { buildSnapshot, findingChanged } from "@/lib/findings"
import { withScopedDb } from "@/lib/with-org"

const adminUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"
const admin = postgres(adminUrl, { max: 1, prepare: false })

const suffix = crypto.randomUUID().slice(0, 8)
const ORG = `org_find_${suffix}`
const OTHER = `org_find_other_${suffix}`
const journeyId = crypto.randomUUID()
const profileId = crypto.randomUUID()
const variants = { A: crypto.randomUUID(), B: crypto.randomUUID() }

async function seed(variant: "A" | "B", totals: number[]) {
  for (const total of totals) {
    const [video] = await admin`
      insert into videos (org_id, task_id, variant_id, title, blob_path, uploaded_by, status)
      values (${ORG}, ${journeyId}, ${variants[variant]}, ${`${variant}${total}`}, ${`f/${crypto.randomUUID()}`},
              'u', 'uploaded') returning id`
    const [run] = await admin`
      insert into analysis_runs (org_id, video_id, pipeline_version, status, fingerprint_hash)
      values (${ORG}, ${video.id}, 'test', 'succeeded', 'fp') returning id`
    await admin`insert into effort_scores (run_id, profile_id, org_id, physical, cognitive, time, sentiment,
                                           speech, total, breakdown)
                values (${run.id}, ${profileId}, ${ORG}, 0, 0, 0, 0, 0, ${total}, '{}'::jsonb)`
  }
}

beforeAll(async () => {
  await admin`insert into orgs (id, name) values (${ORG}, 'F'), (${OTHER}, 'O')`
  await admin`insert into tasks (id, org_id, name) values (${journeyId}, ${ORG}, 'Checkout')`
  await admin`insert into variants (id, org_id, task_id, name)
              values (${variants.A}, ${ORG}, ${journeyId}, 'A'), (${variants.B}, ${ORG}, ${journeyId}, 'B')`
  await admin`insert into weight_profiles (id, org_id, name, weights, normalization, is_default)
              values (${profileId}, ${ORG}, 'Default', '{}'::jsonb, '{}'::jsonb, true)`
  await seed("A", [60, 62, 58, 64, 61])
  await seed("B", [40, 42, 38, 44, 41])
})

afterAll(async () => {
  await admin`delete from findings where org_id = ${ORG}`
  await admin`delete from videos where org_id = ${ORG}`
  await admin`delete from effort_scores where org_id = ${ORG}`
  await admin`delete from analysis_runs where org_id = ${ORG}`
  await admin`delete from weight_profiles where org_id = ${ORG}`
  await admin`delete from tasks where org_id = ${ORG}`
  await admin`delete from orgs where id in (${ORG}, ${OTHER})`
  await admin.end()
})

describe("findings (real Postgres, jams_web role)", () => {
  const source = { kind: "comparison" as const, journey_id: journeyId, by: "variant" as const, a: "A", b: "B" }

  it("builds the snapshot on the server from the source", async () => {
    const snapshot = await withScopedDb(ORG, (scopedDb) => buildSnapshot(ORG, scopedDb, source))
    expect(snapshot).toMatchObject({
      label: "Checkout: A vs B",
      key: "lower",
      reference_fingerprint: "fp",
      details: { difference: -20, a: { n: 5 }, b: { n: 5 } },
    })
    expect(snapshot!.headline).toMatch(/^B takes less effort than A: median 20 lower/)
  })

  it("keeps findings inside their workspace", async () => {
    const snapshot = await withScopedDb(ORG, (scopedDb) => buildSnapshot(ORG, scopedDb, source))
    await withScopedDb(ORG, (scopedDb) =>
      scopedDb.db.insert(findings).values({
        orgId: ORG,
        title: "B is easier",
        kind: "comparison",
        source,
        snapshot: snapshot as unknown as Record<string, unknown>,
        createdBy: "u",
      })
    )
    const mine = await withScopedDb(ORG, (scopedDb) => scopedDb.db.select().from(findings).where(scopedDb.orgFilter(findings)))
    const theirs = await withScopedDb(OTHER, (scopedDb) => scopedDb.db.select().from(findings).where(scopedDb.orgFilter(findings)))
    expect(mine).toHaveLength(1)
    expect(theirs).toHaveLength(0)
    // The other workspace cannot even rebuild a snapshot of this journey.
    expect(await withScopedDb(OTHER, (scopedDb) => buildSnapshot(OTHER, scopedDb, source))).toBeNull()
  })

  it("notices when the live result no longer supports the saved one", async () => {
    const saved = await withScopedDb(ORG, (scopedDb) => buildSnapshot(ORG, scopedDb, source))
    await seed("B", [80, 82, 84, 86, 88, 90, 92])
    const live = await withScopedDb(ORG, (scopedDb) => buildSnapshot(ORG, scopedDb, source))
    expect(findingChanged(saved!, live)).toBe(true)
    expect(findingChanged(saved!, saved)).toBe(false)
  })
})
