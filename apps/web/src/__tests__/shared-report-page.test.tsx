import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const VALID_TOKEN = "a".repeat(43)
const RUN_ID = "8c980f72-91f2-4778-bf2c-57c6f72f9b40"
const ORG_ID = "org_test"

const mocks = vi.hoisted(() => {
  const selectQueue: unknown[][] = []

  function makeChain(): Record<string, unknown> & PromiseLike<unknown[]> {
    const rows = selectQueue.shift() ?? []
    const chain: Record<string, unknown> & PromiseLike<unknown[]> = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: <T, E>(
        onFulfilled?: ((value: unknown[]) => T | PromiseLike<T>) | null,
        onRejected?: ((reason: unknown) => E | PromiseLike<E>) | null
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    }
    return chain
  }

  const mockDb = {
    execute: () => Promise.resolve([]),
    select: vi.fn(() => makeChain()),
    transaction: (handler: (tx: unknown) => unknown) => handler(mockDb),
  }

  return {
    selectQueue,
    mockDb,
    auth: vi.fn(),
    assembleReportPayloadInScope: vi.fn(),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND")
    }),
  }
})

vi.mock("@/db/client", () => ({ db: mocks.mockDb }))
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }))

vi.mock("@/lib/report-assembly", () => ({
  assembleReportPayloadInScope: mocks.assembleReportPayloadInScope,
  ReportNotFoundError: class ReportNotFoundError extends Error {},
  ReportNotReadyError: class ReportNotReadyError extends Error {},
}))

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}))

vi.mock("@/components/report/ReportShell", () => ({
  ReportShell: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="report-shell" data-readonly={readOnly ? "true" : "false"} />
  ),
}))

import SharedReportPage from "@/app/share/[token]/page"

async function renderShare(token: string) {
  return SharedReportPage({ params: Promise.resolve({ token }) })
}

describe("/share/[token]", () => {
  beforeEach(() => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", undefined)
    mocks.mockDb.select.mockClear()
    mocks.selectQueue.length = 0
    mocks.assembleReportPayloadInScope.mockReset()
    mocks.notFound.mockClear()
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it.each([null, "user_uninvited"])("blocks preview sharing before data access for %s", async (userId) => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_invited")
    mocks.auth.mockResolvedValue({ userId })
    await expect(renderShare(VALID_TOKEN)).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.mockDb.select).not.toHaveBeenCalled()
    expect(mocks.assembleReportPayloadInScope).not.toHaveBeenCalled()
  })

  it("allows an invited preview participant to open a valid share", async () => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_invited")
    mocks.auth.mockResolvedValue({ userId: "user_invited" })
    mocks.selectQueue.push([{ runId: RUN_ID, orgId: ORG_ID }])
    mocks.assembleReportPayloadInScope.mockResolvedValue({ run: { id: RUN_ID } })
    expect((await renderShare(VALID_TOKEN)).props.readOnly).toBe(true)
  })

  it("opens a valid share for anyone when public share links are on, without asking who they are", async () => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_invited")
    vi.stubEnv("JAMS_PUBLIC_SHARE_LINKS", "1")
    mocks.auth.mockClear()
    mocks.selectQueue.push([{ runId: RUN_ID, orgId: ORG_ID }])
    mocks.assembleReportPayloadInScope.mockResolvedValue({ run: { id: RUN_ID } })
    expect((await renderShare(VALID_TOKEN)).props.readOnly).toBe(true)
    expect(mocks.auth).not.toHaveBeenCalled()
  })

  it("still refuses an unknown token when public share links are on", async () => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_invited")
    vi.stubEnv("JAMS_PUBLIC_SHARE_LINKS", "1")
    mocks.selectQueue.push([])
    await expect(renderShare(VALID_TOKEN)).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.assembleReportPayloadInScope).not.toHaveBeenCalled()
  })

  it("renders a valid token without auth and passes readOnly to ReportShell", async () => {
    mocks.selectQueue.push([{ runId: RUN_ID, orgId: ORG_ID }])
    mocks.assembleReportPayloadInScope.mockResolvedValue({
      run: { id: RUN_ID },
      video: { title: "Shared report" },
    })

    const element = await renderShare(VALID_TOKEN)

    expect(mocks.assembleReportPayloadInScope).toHaveBeenCalledWith(
      RUN_ID,
      ORG_ID,
      expect.objectContaining({ orgId: ORG_ID, db: mocks.mockDb })
    )
    expect(element.props.readOnly).toBe(true)
  })

  it.each([
    ["invalid token shape", "not-valid"],
    ["missing, expired, or revoked token", VALID_TOKEN],
  ])("returns the same generic 404 for %s", async (_label, token) => {
    if (token === VALID_TOKEN) {
      mocks.selectQueue.push([])
    }

    await expect(renderShare(token)).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.notFound).toHaveBeenCalled()
  })
})
