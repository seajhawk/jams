// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, type NextFetchEvent } from "next/server"

const { session } = vi.hoisted(() => ({ session: Object.assign(vi.fn(), { protect: vi.fn() }) }))

vi.mock("@clerk/nextjs/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/nextjs/server")>()
  return { ...actual, clerkMiddleware: (handler: (auth: typeof session, request: NextRequest) => unknown) =>
    (request: NextRequest) => handler(session, request) }
})

import proxy from "@/proxy"

const handle = (_auth: typeof session, request: NextRequest) =>
  proxy(request, {} as NextFetchEvent) as Promise<Response | undefined>

describe("private preview request boundary", () => {
  beforeEach(() => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", "user_invited")
    session.mockResolvedValue({ userId: "user_other" })
    session.protect.mockResolvedValue(undefined)
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

  it.each(["/api/videos", "/api/analyses", "/library", "/share/a-token"])(
    "denies uninvited requests to %s before the handler", async (path) => {
      const result = await handle(session, new NextRequest(`http://localhost${path}`))
      expect(result?.status).toBe(403)
      expect(result?.headers.get("Cache-Control")).toBe("no-store")
      expect(session.protect).not.toHaveBeenCalled()
    }
  )

  it("denies anonymous shared reports", async () => {
    session.mockResolvedValue({ userId: null })
    const result = await handle(session, new NextRequest("http://localhost/share/token"))
    expect(result?.status).toBe(403)
  })

  it("keeps authentication protection for an admitted API caller", async () => {
    session.mockResolvedValue({ userId: "user_invited" })
    expect(await handle(session, new NextRequest("http://localhost/api/videos"))).toBeUndefined()
    expect(session.protect).toHaveBeenCalledOnce()
  })

  it.each(["/", "/sign-in", "/sign-up", "/api/webhooks/clerk", "/api/webhooks/stripe"])(
    "keeps entry or signed-webhook route %s reachable", async (path) => {
      expect(await handle(session, new NextRequest(`http://localhost${path}`))).toBeUndefined()
      expect(session).not.toHaveBeenCalled()
    }
  )

  it("preserves anonymous sharing when preview admission is not configured", async () => {
    vi.stubEnv("JAMS_PREVIEW_USER_IDS", undefined)
    expect(await handle(session, new NextRequest("http://localhost/share/token"))).toBeUndefined()
    expect(session).not.toHaveBeenCalled()
  })

  it.each(["/privacy", "/terms"])("keeps the public trust page %s reachable in preview", async (path) => {
    expect(await handle(session, new NextRequest(`http://localhost${path}`))).toBeUndefined()
    expect(session).not.toHaveBeenCalled()
  })

  it("lets share links through the preview gate only when public share links are on", async () => {
    session.mockResolvedValue({ userId: null })
    vi.stubEnv("JAMS_PUBLIC_SHARE_LINKS", "1")
    expect(await handle(session, new NextRequest("http://localhost/share/token"))).toBeUndefined()
    // Only share links: other pages stay invitation-only.
    expect((await handle(session, new NextRequest("http://localhost/library")))?.status).toBe(403)
  })

  it("offers a way to request access on the invitation-only page when a contact is set", async () => {
    vi.stubEnv("JAMS_CONTACT_EMAIL", "preview@example.com")
    const withContact = await handle(session, new NextRequest("http://localhost/library"))
    const html = await withContact!.text()
    expect(html).toContain('href="mailto:preview@example.com?subject=JAMS%20preview%20access"')
    expect(html).toContain("Request access")
    expect(html).toContain('href="/privacy"')

    vi.stubEnv("JAMS_CONTACT_EMAIL", "not an address")
    const without = await (await handle(session, new NextRequest("http://localhost/library")))!.text()
    expect(without).not.toContain("mailto:")
    expect(without).toContain("sign in with the email address the invitation was sent to")
  })

  it.each(["/api/admin/watchdog", "/api/admin/reconcile"])(
    "leaves %s authentication to the scheduler-secret verifier", async (path) => {
      expect(await handle(session, new NextRequest(`http://localhost${path}`))).toBeUndefined()
      expect(session).not.toHaveBeenCalled()
      expect(session.protect).not.toHaveBeenCalled()
    }
  )

  it("does not exempt neighboring admin routes", async () => {
    expect((await handle(session, new NextRequest("http://localhost/api/admin/runs/id/requeue")))?.status)
      .toBe(403)
  })

  it("allows only the exact liveness path without consulting identity", async () => {
    expect((await handle(session, new NextRequest("http://localhost/api/health/live")))?.status).toBe(200)
    expect(session).not.toHaveBeenCalled()
    expect((await handle(session, new NextRequest("http://localhost/api/health/live/private")))?.status).toBe(403)
  })
})
