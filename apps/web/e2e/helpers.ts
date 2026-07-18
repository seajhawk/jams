import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright"
import { expect, type Page } from "@playwright/test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const e2eUserEmail =
  process.env.E2E_CLERK_USER_EMAIL ?? "jams-e2e-playwright@example.com"

async function e2eOrgId() {
  if (process.env.E2E_CLERK_ORG_ID) return process.env.E2E_CLERK_ORG_ID
  const state = JSON.parse(
    await fs.readFile(path.join(process.cwd(), ".e2e-user.local.json"), "utf8")
  ) as { orgId?: string }
  if (!state.orgId) {
    throw new Error("E2E Clerk organization id is missing")
  }
  return state.orgId
}

export async function signInE2eUser(page: Page) {
  await setupClerkTestingToken({ page })
  await page.goto("/")
  await clerk.signIn({ page, emailAddress: e2eUserEmail })
  const orgId = await e2eOrgId()
  await page.evaluate(async (organization) => {
    const clerk = (
      window as unknown as {
        Clerk?: { setActive: (input: { organization: string }) => Promise<void> }
      }
    ).Clerk
    await clerk?.setActive({ organization })
  }, orgId)
}

export async function expectAppReady(page: Page) {
  await expect(page.getByRole("link", { name: "Library" }).first()).toBeVisible()
}

export async function dockerExec(args: string[]) {
  const { stdout } = await execFileAsync("docker", args, {
    cwd: "../..",
    env: process.env,
    windowsHide: true,
  })
  return stdout.trim()
}

export function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}
