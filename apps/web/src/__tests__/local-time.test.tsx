import { act } from "@testing-library/react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LocalTime, stableUtc } from "@/components/ui/local-time"

const INSTANT = "2026-09-23T03:07:00.000Z"

describe("stableUtc", () => {
  it("formats without ICU or the host timezone", () => {
    const date = new Date(INSTANT)
    expect(stableUtc(date, "datetime")).toBe("2026-09-23 03:07 UTC")
    expect(stableUtc(date, "date")).toBe("2026-09-23")
  })
})

describe("LocalTime", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    vi.restoreAllMocks()
  })

  it("renders the stable UTC form on the server, whatever the server's locale", () => {
    // What toLocaleString would do on a UTC container vs a Pacific laptop is exactly the bug;
    // the server output must not depend on it.
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("SERVER LOCALE")

    const html = renderToString(<LocalTime value={INSTANT} />)

    expect(html).toContain("2026-09-23 03:07 UTC")
    expect(html).not.toContain("SERVER LOCALE")
    expect(html).toContain(`dateTime="${INSTANT}"`)
  })

  it("hydrates cleanly, then shows the viewer's own local time", async () => {
    const html = renderToString(<LocalTime value={INSTANT} />)
    const container = document.createElement("div")
    container.innerHTML = html
    document.body.appendChild(container)

    // The browser formats differently from the server; that must not be a hydration mismatch.
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("9/22/2026, 8:07:00 PM")
    const recoverable = vi.fn()

    await act(async () => {
      hydrateRoot(container, <LocalTime value={INSTANT} />, { onRecoverableError: recoverable })
    })

    expect(recoverable).not.toHaveBeenCalled()
    expect(container.textContent).toBe("9/22/2026, 8:07:00 PM")
  })

  it("renders nothing for an unparseable value instead of 'Invalid Date'", () => {
    expect(renderToString(<LocalTime value="not a date" />)).toBe("")
  })
})
