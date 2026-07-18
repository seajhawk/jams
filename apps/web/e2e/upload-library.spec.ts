import { BlobServiceClient } from "@azure/storage-blob"
import { expect, test } from "@playwright/test"
import path from "node:path"

import {
  dockerExec,
  expectAppReady,
  signInE2eUser,
  sqlLiteral,
} from "./helpers"

const runId =
  process.env.E2E_RUN_ID ??
  new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
const title = `E2E Tiny ${runId}`
const taskName = "E2E Task"
const fixturePath = path.join(process.cwd(), "..", "..", "fixtures", "e2e-tiny.mp4")

type ServerTruth = {
  id: string
  status: string
  orgId: string
  taskOrgId: string
  taskName: string
  blobPath: string
}

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

async function cleanupRunData() {
  await psql(`delete from videos where title = ${sqlLiteral(title)};`)
  await psql(`delete from tasks where name = ${sqlLiteral(taskName)};`)
}

async function getServerTruth(): Promise<ServerTruth> {
  const row = await psql(`
    select v.id, v.status, v.org_id, t.org_id, t.name, v.blob_path
    from videos v
    join tasks t on t.id = v.task_id
    where v.title = ${sqlLiteral(title)}
  `)
  const [id, status, orgId, taskOrgId, rowTaskName, blobPath] = row.split("|")
  return { id, status, orgId, taskOrgId, taskName: rowTaskName, blobPath }
}

test.beforeAll(async () => {
  await cleanupRunData()
})

test.afterAll(async () => {
  await cleanupRunData()
})

test("uploads a tiny video, opens detail playback, and verifies server truth", async ({
  page,
}) => {
  test.setTimeout(60_000)

  await signInE2eUser(page)
  await page.goto("/library")
  await expectAppReady(page)

  await page.getByRole("button", { name: "Upload journey" }).first().click()
  await page.getByTestId("upload-file-input").setInputFiles(fixturePath)

  const titleInput = page.getByLabel("Title")
  await expect(titleInput).toHaveValue("e2e-tiny")
  await titleInput.fill(title)

  await page.getByLabel("Task").selectOption("__new__")
  await page.getByTestId("new-task-name").fill(taskName)
  await page.getByRole("button", { name: "Upload" }).click()

  await expect(page.getByText("Video uploaded")).toBeVisible({
    timeout: 30_000,
  })

  const card = page
    .getByTestId("video-card")
    .filter({ has: page.getByText(title, { exact: true }) })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByText("Uploaded", { exact: true })).toBeVisible()
  await expect(card.getByText(taskName, { exact: true })).toBeVisible()
  await expect(card.locator("span", { hasText: /\d+:\d{2}/ }).first()).toBeVisible()

  const truth = await getServerTruth()

  await page.goto(`/library/${truth.id}`)
  await expect(page.getByRole("heading", { name: title })).toBeVisible()

  const detailPlayer = page.getByTestId("video-detail-player")
  await expect(detailPlayer).toHaveAttribute("data-src", /sig=/)
  await expect(page.getByText(taskName, { exact: true })).toBeVisible()

  expect(truth.status).toBe("uploaded")
  expect(truth.taskName).toBe(taskName)
  expect(truth.orgId).toBeTruthy()
  expect(truth.taskOrgId).toBe(truth.orgId)
  expect(truth.blobPath).toContain("/original.mp4")

  const service = BlobServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING ??
      "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;"
  )
  const blobExists = await service
    .getContainerClient("videos")
    .getBlockBlobClient(truth.blobPath)
    .exists()
  expect(blobExists).toBe(true)
})
