import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  listAdminRuns: vi.fn(),
  peekAnalysisPoisonMessages: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }))
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }))
vi.mock("@/lib/admin-runs", () => ({ listAdminRuns: mocks.listAdminRuns }))
vi.mock("@/lib/queue", () => ({ peekAnalysisPoisonMessages: mocks.peekAnalysisPoisonMessages }))

import AdminPage from "@/app/admin/page"

const params = { searchParams: Promise.resolve({}) }

/**
 * The admin layout also checks, but in the App Router a layout does not stop its page from
 * rendering or from reaching the RSC payload. The page reads every tenant's runs, so it must
 * refuse on its own, before touching any data.
 */
describe("admin page", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_USER_IDS", "user_admin")
    mocks.auth.mockReset()
    mocks.listAdminRuns.mockReset().mockResolvedValue([])
    mocks.peekAnalysisPoisonMessages.mockReset().mockResolvedValue([])
    mocks.notFound.mockClear()
  })

  it("refuses a signed-in user who is not a platform admin, without reading any runs", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_ordinary" })

    await expect(AdminPage(params)).rejects.toThrow("NEXT_NOT_FOUND")

    expect(mocks.listAdminRuns).not.toHaveBeenCalled()
    expect(mocks.peekAnalysisPoisonMessages).not.toHaveBeenCalled()
  })

  it("refuses an anonymous request, without reading any runs", async () => {
    mocks.auth.mockResolvedValue({ userId: null })

    await expect(AdminPage(params)).rejects.toThrow("NEXT_NOT_FOUND")

    expect(mocks.listAdminRuns).not.toHaveBeenCalled()
  })

  it("renders for a platform admin", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_admin" })

    await expect(AdminPage(params)).resolves.toBeTruthy()

    expect(mocks.listAdminRuns).toHaveBeenCalledWith("failed")
  })
})
