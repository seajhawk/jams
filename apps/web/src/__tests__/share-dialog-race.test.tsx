import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ShareReportDialog } from "@/components/report/ShareReportDialog"

const RUN_ID = "8c980f72-91f2-4778-bf2c-57c6f72f9b40"

const link = (id: string, createdAt: string, revoked = false) => ({
  id,
  run_id: RUN_ID,
  created_at: createdAt,
  expires_at: "2099-01-01T00:00:00.000Z",
  revoked_at: revoked ? "2026-09-24T10:00:00.000Z" : null,
  last4: id.slice(-4),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response

describe("share dialog", () => {
  let listResponse: ReturnType<typeof deferred<Response>>

  beforeEach(() => {
    listResponse = deferred<Response>()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `/api/analyses/${RUN_ID}/share` && !init?.method) return listResponse.promise
        if (url === `/api/analyses/${RUN_ID}/share` && init?.method === "POST") {
          return json({
            link: link("new-link-aaaa", "2026-09-24T12:00:00.000Z"),
            token: "t".repeat(43),
            url: `https://jams.test/share/${"t".repeat(43)}`,
          })
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`)
      })
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  async function openAndCreateBeforeTheListArrives() {
    render(<ShareReportDialog runId={RUN_ID} />)
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create link" }))
    })
  }

  it("keeps a link created while the list was still loading", async () => {
    await openAndCreateBeforeTheListArrives()

    // The list request was sent when the dialog opened, before the link existed.
    await act(async () => {
      listResponse.resolve(json({ links: [] }))
    })

    expect(screen.getAllByRole("button", { name: "Revoke share link" })).toHaveLength(1)
    expect(screen.getByText("...aaaa")).toBeTruthy()
  })

  it("still shows older links from the server alongside the new one, newest first", async () => {
    await openAndCreateBeforeTheListArrives()

    await act(async () => {
      listResponse.resolve(json({ links: [link("old-link-bbbb", "2026-09-20T09:00:00.000Z", true)] }))
    })

    const rows = screen.getAllByRole("button", { name: "Revoke share link" }).map((b) => b.closest("div.rounded-md")!)
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText("...aaaa")).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText("Revoked")).toBeTruthy()
  })

  it("uses the server's list as-is when nothing changed in the meantime", async () => {
    render(<ShareReportDialog runId={RUN_ID} />)
    fireEvent.click(screen.getByRole("button", { name: "Share" }))

    await act(async () => {
      listResponse.resolve(json({ links: [link("old-link-bbbb", "2026-09-20T09:00:00.000Z")] }))
    })

    expect(screen.getAllByRole("button", { name: "Revoke share link" })).toHaveLength(1)
    expect(screen.getByText("...bbbb")).toBeTruthy()
  })
})
