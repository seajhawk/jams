import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { participants } from "@/db/schema"
import { HttpError } from "@/lib/api"
import { assertInOrg, journeyStats, loadJourneySessions } from "@/lib/hierarchy"
import { withScopedDb } from "@/lib/with-org"

const adminUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"
const admin = postgres(adminUrl, { max: 1, prepare: false })

const suffix = crypto.randomUUID().slice(0, 8)
const ORG_A = `org_hier_a_${suffix}`
const ORG_B = `org_hier_b_${suffix}`
const ids = {
  project: crypto.randomUUID(),
  goal: crypto.randomUUID(),
  journey: crypto.randomUUID(),
  participantA: crypto.randomUUID(),
  participantB: crypto.randomUUID(),
  variant: crypto.randomUUID(),
  profile: crypto.randomUUID(),
}
const videoIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]

beforeAll(async () => {
  await admin`insert into orgs (id, name) values (${ORG_A}, 'A'), (${ORG_B}, 'B')`
  await admin`insert into projects (id, org_id, name) values (${ids.project}, ${ORG_A}, 'P')`
  await admin`insert into goals (id, org_id, project_id, name)
              values (${ids.goal}, ${ORG_A}, ${ids.project}, 'G')`
  await admin`insert into tasks (id, org_id, goal_id, name)
              values (${ids.journey}, ${ORG_A}, ${ids.goal}, 'J')`
  await admin`insert into participants (id, org_id, label, cohorts)
              values (${ids.participantA}, ${ORG_A}, 'P01', ${["beginner"]}),
                     (${ids.participantB}, ${ORG_B}, 'P99', ${[]})`
  await admin`insert into variants (id, org_id, task_id, name, build)
              values (${ids.variant}, ${ORG_A}, ${ids.journey}, 'B', '2026.09.2')`
  await admin`insert into weight_profiles (id, org_id, name, weights, normalization, is_default)
              values (${ids.profile}, ${ORG_A}, 'Default', '{}'::jsonb, '{}'::jsonb, true)`

  // Three sessions: two scored (totals 40 and 60, different fingerprints), one never analyzed.
  const totals = [40, 60]
  for (const [index, videoId] of videoIds.entries()) {
    await admin`insert into videos (id, org_id, task_id, title, blob_path, uploaded_by, status,
                                    participant_id, variant_id)
                values (${videoId}, ${ORG_A}, ${ids.journey}, ${`s${index}`}, ${`a/${index}`}, 'u',
                        'uploaded', ${index === 0 ? ids.participantA : null},
                        ${index === 0 ? ids.variant : null})`
    if (index >= totals.length) continue
    const oldRun = crypto.randomUUID()
    const latestRun = crypto.randomUUID()
    // A superseded run with a wild score must be ignored.
    await admin`insert into analysis_runs (id, org_id, video_id, pipeline_version, status)
                values (${oldRun}, ${ORG_A}, ${videoId}, 'test', 'succeeded')`
    await admin`insert into analysis_runs (id, org_id, video_id, pipeline_version, status,
                                           fingerprint_hash)
                values (${latestRun}, ${ORG_A}, ${videoId}, 'test', 'succeeded', ${`fp${index}`})`
    await admin`update analysis_runs set superseded_by = ${latestRun} where id = ${oldRun}`
    for (const [runId, total] of [[oldRun, 99], [latestRun, totals[index]]] as const) {
      await admin`insert into effort_scores (run_id, profile_id, org_id, physical, cognitive, time,
                                             sentiment, speech, total, breakdown)
                  values (${runId}, ${ids.profile}, ${ORG_A}, 0, 0, 0, 0, 0, ${total}, '{}'::jsonb)`
    }
  }
})

afterAll(async () => {
  await admin`delete from videos where org_id = ${ORG_A}`
  await admin`delete from effort_scores where org_id = ${ORG_A}`
  await admin`delete from analysis_runs where org_id = ${ORG_A}`
  await admin`delete from weight_profiles where org_id = ${ORG_A}`
  await admin`delete from projects where org_id = ${ORG_A}`
  await admin`delete from tasks where org_id = ${ORG_A}`
  await admin`delete from participants where org_id in (${ORG_A}, ${ORG_B})`
  await admin`delete from orgs where id in (${ORG_A}, ${ORG_B})`
  await admin.end()
})

describe("journey sessions and stats (real Postgres, jams_web role)", () => {
  it("uses each session's latest analysis and the default profile's total", async () => {
    const sessions = await withScopedDb(ORG_A, (scopedDb) =>
      loadJourneySessions(ORG_A, scopedDb, [ids.journey])
    )
    const journeySessions = sessions.get(ids.journey) ?? []

    expect(journeySessions).toHaveLength(3)
    const totals = journeySessions.map((s) => s.analysis?.total ?? null).sort()
    expect(totals).toEqual([40, 60, null])
    const first = journeySessions.find((s) => s.participant)
    expect(first?.participant).toEqual({ id: ids.participantA, label: "P01", cohorts: ["beginner"] })
    expect(first?.variant).toEqual({ id: ids.variant, name: "B", build: "2026.09.2" })

    // The two scored sessions use different definitions: only the newest one's (fp1, total 60)
    // is aggregated; the other is excluded rather than averaged in.
    expect(journeyStats(journeySessions)).toEqual({
      session_count: 3,
      n: 1,
      median: 60,
      p25: 60,
      p75: 60,
      reference_fingerprint: "fp1",
      excluded: 1,
      fingerprint_count: 2,
      mixed_definitions: true,
    })
  })

  it("shows another workspace nothing", async () => {
    const sessions = await withScopedDb(ORG_B, (scopedDb) =>
      loadJourneySessions(ORG_B, scopedDb, [ids.journey])
    )
    expect(sessions.get(ids.journey) ?? []).toEqual([])
  })

  it("rejects another workspace's ids", async () => {
    await expect(
      withScopedDb(ORG_B, (scopedDb) =>
        assertInOrg(scopedDb, participants, ids.participantA, "Participant")
      )
    ).rejects.toBeInstanceOf(HttpError)
    await expect(
      withScopedDb(ORG_A, (scopedDb) =>
        assertInOrg(scopedDb, participants, ids.participantA, "Participant")
      )
    ).resolves.toBeUndefined()
  })
})
