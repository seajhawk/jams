import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { HttpError } from "@/lib/api"
import { queueAnalysisInScope } from "@/lib/queue-analysis"
import { withScopedDb } from "@/lib/with-org"

const adminUrl = process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"
const admin = postgres(adminUrl, { max: 1, prepare: false })

const ORG = `org_queue_${crypto.randomUUID().slice(0, 8)}`
const uploaded = crypto.randomUUID()
const uploading = crypto.randomUUID()
const oldRun = crypto.randomUUID()

beforeAll(async () => {
  await admin`insert into orgs (id, name) values (${ORG}, 'Q')`
  await admin`insert into videos (id, org_id, title, blob_path, uploaded_by, status)
              values (${uploaded}, ${ORG}, 'done', 'q/1', 'u', 'uploaded'),
                     (${uploading}, ${ORG}, 'pending', 'q/2', 'u', 'uploading')`
  await admin`insert into analysis_runs (id, org_id, video_id, pipeline_version, status)
              values (${oldRun}, ${ORG}, ${uploaded}, 'test', 'succeeded')`
})

afterAll(async () => {
  await admin`delete from videos where org_id = ${ORG}`
  await admin`delete from weight_profiles where org_id = ${ORG}`
  await admin`delete from orgs where id = ${ORG}`
  await admin.end()
})

describe("queueAnalysisInScope (real Postgres, jams_web role)", () => {
  it("queues a run with the given config and supersedes the previous one", async () => {
    const { run, outboxId } = await withScopedDb(ORG, (scopedDb) =>
      queueAnalysisInScope(ORG, scopedDb, {
        videoId: uploaded,
        config: { sentiment: { fallback: "vader" } },
        configSource: "reanalyze_outdated",
      })
    )
    expect(outboxId).toBeTruthy()
    const [stored] = await admin`select status, config, config_source from analysis_runs where id = ${run.id}`
    expect(stored).toMatchObject({
      status: "queued",
      config: { sentiment: { fallback: "vader" } },
      config_source: "reanalyze_outdated",
    })
    const [previous] = await admin`select superseded_by from analysis_runs where id = ${oldRun}`
    expect(previous.superseded_by).toBe(run.id)
  })

  it("refuses a session that has not finished uploading", async () => {
    await expect(
      withScopedDb(ORG, (scopedDb) =>
        queueAnalysisInScope(ORG, scopedDb, { videoId: uploading, config: {}, configSource: null })
      )
    ).rejects.toBeInstanceOf(HttpError)
  })
})
