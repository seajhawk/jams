import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadJourneySteps } from "@/lib/journey-steps"
import { withScopedDb } from "@/lib/with-org"

const adminUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"
const admin = postgres(adminUrl, { max: 1, prepare: false })

const suffix = crypto.randomUUID().slice(0, 8)
const ORG = `org_steps_${suffix}`
const OTHER = `org_steps_other_${suffix}`
const journeyId = crypto.randomUUID()
const steps = ["Sign in", "Configure settings"]
const profileId = crypto.randomUUID()
const sessions = [
  { video: crypto.randomUUID(), run: crypto.randomUUID(), frustrated: true, boundaries: null as number[] | null },
  { video: crypto.randomUUID(), run: crypto.randomUUID(), frustrated: false, boundaries: [30_000] },
]

async function measure(runId: string, kind: string, category: string, t: number, value: number | null, text: string | null, payload = {}) {
  const [row] = await admin`
    insert into measures (run_id, org_id, kind, category, t_start_ms, value_num, value_text, source,
                          provider_id, provider_version, payload)
    values (${runId}, ${ORG}, ${kind}, ${category}, ${t}, ${value}, ${text}, 'video_analysis', 'test',
            '1', ${admin.json(payload)})
    returning id`
  return row.id as string
}

beforeAll(async () => {
  await admin`insert into orgs (id, name) values (${ORG}, 'S'), (${OTHER}, 'O')`
  await admin`insert into tasks (id, org_id, name, steps) values (${journeyId}, ${ORG}, 'J', ${admin.json(steps)})`
  await admin`insert into weight_profiles (id, org_id, name, weights, normalization, is_default)
              values (${profileId}, ${ORG}, 'Default', '{}'::jsonb, '{}'::jsonb, true)`
  for (const [index, session] of sessions.entries()) {
    await admin`insert into videos (id, org_id, task_id, title, blob_path, uploaded_by, status, duration_ms,
                                    step_boundaries_ms)
                values (${session.video}, ${ORG}, ${journeyId}, ${`s${index}`}, ${`s/${index}`}, 'u',
                        'uploaded', 60000, ${session.boundaries ? admin.json(session.boundaries) : null})`
    await admin`insert into analysis_runs (id, org_id, video_id, pipeline_version, status, fingerprint_hash)
                values (${session.run}, ${ORG}, ${session.video}, 'test', 'succeeded', 'fp')`
    await admin`insert into effort_scores (run_id, profile_id, org_id, physical, cognitive, time, sentiment,
                                           speech, total, breakdown)
                values (${session.run}, ${profileId}, ${ORG}, 0, 0, 0, 0, 0, 50, '{}'::jsonb)`
    await admin`insert into segments (org_id, run_id, name, t_start_ms, t_end_ms, source)
                values (${ORG}, ${session.run}, 'Signing in', 0, 20000, 'audio_cue'),
                       (${ORG}, ${session.run}, 'Configuring the settings', 20000, 60000, 'audio_cue')`
    if (session.frustrated) {
      const utterance = await measure(session.run, "utterance", "speech", 41_000, null, "why won't this save")
      await measure(session.run, "sentiment", "sentiment", 41_000, -0.8, null, { utterance_measure_id: utterance })
    }
    await measure(session.run, "context_switch", "cognitive", 25_000, null, null)
  }
})

afterAll(async () => {
  await admin`delete from videos where org_id = ${ORG}`
  await admin`delete from measures where org_id = ${ORG}`
  await admin`delete from segments where org_id = ${ORG}`
  await admin`delete from effort_scores where org_id = ${ORG}`
  await admin`delete from analysis_runs where org_id = ${ORG}`
  await admin`delete from weight_profiles where org_id = ${ORG}`
  await admin`delete from tasks where org_id = ${ORG}`
  await admin`delete from orgs where id in (${ORG}, ${OTHER})`
  await admin.end()
})

describe("loadJourneySteps (real Postgres, jams_web role)", () => {
  it("aligns each session and finds the frustrated step with its words", async () => {
    const view = await withScopedDb(ORG, (scopedDb) =>
      loadJourneySteps(ORG, scopedDb, { id: journeyId, steps }, {})
    )
    const bySource = Object.fromEntries(view.sessions.map((s) => [s.title, s.source]))
    expect(bySource).toEqual({ s0: "matched", s1: "manual" })
    const manual = view.sessions.find((s) => s.title === "s1")!
    expect(manual.spans.map((s) => s.t_end_ms)).toEqual([30_000, 60_000])

    const configure = view.hotspots[1]
    expect(configure).toMatchObject({ step: "Configure settings", sessions: 2, frustrated_sessions: 1 })
    expect(configure.evidence[0]).toMatchObject({ t_ms: 41_000, text: "why won't this save" })
    expect(view.ranked[0]).toBe(1)
    expect(view.estimated).toBe(false)
  })

  it("suggests step names from an analysis that has segments but no score yet", async () => {
    const bareJourney = crypto.randomUUID()
    const video = crypto.randomUUID()
    const run = crypto.randomUUID()
    await admin`insert into tasks (id, org_id, name) values (${bareJourney}, ${ORG}, 'Unscored')`
    await admin`insert into videos (id, org_id, task_id, title, blob_path, uploaded_by, status, duration_ms)
                values (${video}, ${ORG}, ${bareJourney}, 'partial', 's/partial', 'u', 'uploaded', 30000)`
    await admin`insert into analysis_runs (id, org_id, video_id, pipeline_version, status)
                values (${run}, ${ORG}, ${video}, 'test', 'partial')`
    await admin`insert into segments (org_id, run_id, name, t_start_ms, t_end_ms, source)
                values (${ORG}, ${run}, 'Open the wizard', 0, 10000, 'audio_cue'),
                       (${ORG}, ${run}, 'Fill in details', 10000, 30000, 'audio_cue')`
    const view = await withScopedDb(ORG, (scopedDb) =>
      loadJourneySteps(ORG, scopedDb, { id: bareJourney, steps: [] }, {})
    )
    expect(view.sessions).toEqual([])
    expect([...view.suggestions].sort()).toEqual(["Fill in details", "Open the wizard"])
  })

  it("shows another workspace nothing", async () => {
    const view = await withScopedDb(OTHER, (scopedDb) =>
      loadJourneySteps(OTHER, scopedDb, { id: journeyId, steps }, {})
    )
    expect(view.sessions).toEqual([])
    expect(view.hotspots).toEqual([])
  })
})
