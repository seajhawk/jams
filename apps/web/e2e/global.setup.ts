import { BlobServiceClient } from "@azure/storage-blob"
import { clerkSetup } from "@clerk/testing/playwright"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"

const userFile = path.join(process.cwd(), ".e2e-user.local.json")
const email = "jams-e2e-playwright@example.com"
const localStorageConnectionString =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;"

type E2eUserFile = {
  email: string
  password: string
  orgId?: string
}

type ClerkUser = {
  id: string
}

type ClerkUserListResponse = ClerkUser[] | { data?: ClerkUser[] }

function firstClerkUser(body: ClerkUserListResponse) {
  return Array.isArray(body) ? body[0] : body.data?.[0]
}

function readEnvFile(filePath: string) {
  return fs
    .readFile(filePath, "utf8")
    .then((contents) => {
      for (const line of contents.split(/\r?\n/)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
        if (!match || process.env[match[1]]) continue
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "")
      }
    })
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return
      }
      throw error
    })
}

async function readOrCreateUserFile(): Promise<E2eUserFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(userFile, "utf8")) as E2eUserFile
    if (parsed.email === email && parsed.password) {
      return parsed
    }
  } catch {
    // Missing or malformed local state is fine; it will be regenerated.
  }

  const state = {
    email,
    password: `JamsE2E-${crypto.randomUUID()}!`,
  }
  await fs.writeFile(userFile, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  })
  return state
}

async function clerkRequest(pathname: string, init: RequestInit = {}) {
  const secretKey = process.env.CLERK_SECRET_KEY
  if (!secretKey || secretKey === "sk_test_placeholder") {
    throw new Error("CLERK_SECRET_KEY is required for Clerk E2E setup")
  }

  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${secretKey}`)
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return fetch(`https://api.clerk.com/v1${pathname}`, {
    ...init,
    headers,
  })
}

async function ensureClerkUser(user: E2eUserFile): Promise<ClerkUser> {
  const listParams = new URLSearchParams({ email_address: user.email })

  const listResponse = await clerkRequest(`/users?${listParams}`)
  if (!listResponse.ok) {
    throw new Error(`Failed to query Clerk E2E user: ${listResponse.status}`)
  }
  const listBody = (await listResponse.json()) as ClerkUserListResponse
  const existing = firstClerkUser(listBody)
  if (existing) {
    return existing
  }

  const createResponse = await clerkRequest("/users", {
    method: "POST",
    body: JSON.stringify({
      email_address: [user.email],
      password: user.password,
      first_name: "JAMS",
      last_name: "E2E",
      skip_password_checks: true,
      skip_legal_checks: true,
    }),
  })

  if (!createResponse.ok && createResponse.status !== 422) {
    const body = await createResponse.text()
    throw new Error(`Failed to create Clerk E2E user: ${createResponse.status} ${body}`)
  }

  if (createResponse.status === 422) {
    const retryResponse = await clerkRequest(`/users?${listParams}`)
    const retryBody = (await retryResponse.json()) as ClerkUserListResponse
    const retryUser = firstClerkUser(retryBody)
    if (retryUser) return retryUser
  }

  return (await createResponse.json()) as ClerkUser
}

async function writeUserFile(user: E2eUserFile) {
  await fs.writeFile(userFile, `${JSON.stringify(user, null, 2)}\n`, {
    mode: 0o600,
  })
}

async function ensureClerkOrganization(user: E2eUserFile, userId: string) {
  let organizationId = user.orgId

  if (!organizationId) {
    const createResponse = await clerkRequest("/organizations", {
      method: "POST",
      body: JSON.stringify({
        name: "JAMS E2E workspace",
        created_by: userId,
        max_allowed_memberships: 1,
        private_metadata: { personal: true, e2e: true },
      }),
    })

    if (createResponse.ok) {
      const created = (await createResponse.json()) as { id: string }
      organizationId = created.id
      user.orgId = organizationId
      await writeUserFile(user)
    } else if (createResponse.status !== 422) {
      const body = await createResponse.text()
      throw new Error(
        `Failed to create Clerk E2E organization: ${createResponse.status} ${body}`
      )
    }
  }

  if (!organizationId) {
    return
  }

  const membershipResponse = await clerkRequest(
    `/organizations/${organizationId}/memberships`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        role: "org:admin",
      }),
    }
  )

  if (!membershipResponse.ok && membershipResponse.status !== 422) {
    const body = await membershipResponse.text()
    if (
      membershipResponse.status === 403 &&
      body.includes("organization_membership_quota_exceeded")
    ) {
      return
    }
    throw new Error(
      `Failed to create Clerk E2E organization membership: ${membershipResponse.status} ${body}`
    )
  }
}

async function configureLocalBlobCors() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
  if (!connectionString?.includes("localhost:10000")) return

  const service = BlobServiceClient.fromConnectionString(connectionString)
  await service.setProperties({
    cors: [
      {
        allowedHeaders: "*",
        allowedMethods: "GET,HEAD,OPTIONS,PUT",
        allowedOrigins: "http://localhost:3000",
        exposedHeaders: "*",
        maxAgeInSeconds: 3600,
      },
    ],
  })
}

export default async function globalSetup() {
  await readEnvFile(path.join(process.cwd(), ".env.local"))
  await readEnvFile(path.join(process.cwd(), "..", "..", ".env"))
  process.env.AZURE_STORAGE_CONNECTION_STRING ??= localStorageConnectionString

  const user = await readOrCreateUserFile()
  process.env.E2E_CLERK_USER_EMAIL = user.email
  process.env.E2E_CLERK_USER_PASSWORD = user.password

  const clerkUser = await ensureClerkUser(user)
  await ensureClerkOrganization(user, clerkUser.id)
  process.env.E2E_CLERK_ORG_ID = user.orgId
  await configureLocalBlobCors()
  await clerkSetup()
}
