import { beforeEach, describe, expect, it, vi } from "vitest"

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

  return {
    selectQueue,
    mockDb: { select: () => makeChain() },
    assembleReportPayload: vi.fn(),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND")
    }),
  }
})

vi.mock("@/db/client", () => ({ db: mocks.mockDb }))

vi.mock("@/lib/report-assembly", () => ({
  assembleReportPayload: mocks.assembleReportPayload,
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
    mocks.selectQueue.length = 0
    mocks.assembleReportPayload.mockReset()
    mocks.notFound.mockClear()
  })

  it("renders a valid token without auth and passes readOnly to ReportShell", async () => {
    mocks.selectQueue.push([{ runId: RUN_ID, orgId: ORG_ID }])
    mocks.assembleReportPayload.mockResolvedValue({
      run: { id: RUN_ID },
      video: { title: "Shared report" },
    })

    const element = await renderShare(VALID_TOKEN)

    expect(mocks.assembleReportPayload).toHaveBeenCalledWith(RUN_ID, ORG_ID)
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
