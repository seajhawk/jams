import { describe, expect, it } from "vitest"

import { publicOrigin } from "@/lib/public-origin"

/** What the standalone server gives a route handler on Azure: request.url is the bind address. */
function containerRequest(headers: Record<string, string>) {
  return new Request("http://0.0.0.0:3000/api/analyses/x/share", { method: "POST", headers })
}

describe("publicOrigin", () => {
  it("uses the ingress's forwarded host and protocol, not the container's bind address", () => {
    const origin = publicOrigin(
      containerRequest({
        host: "jams-web.wittysky-66807383.eastus2.azurecontainerapps.io",
        "x-forwarded-proto": "https",
      }),
      undefined
    )

    expect(origin).toBe("https://jams-web.wittysky-66807383.eastus2.azurecontainerapps.io")
  })

  it("prefers X-Forwarded-Host, taking the first hop when proxies chained it", () => {
    const origin = publicOrigin(
      containerRequest({
        host: "internal:3000",
        "x-forwarded-host": "app.jams.example, internal-proxy",
        "x-forwarded-proto": "https, http",
      }),
      undefined
    )

    expect(origin).toBe("https://app.jams.example")
  })

  it("uses a configured public origin over anything in the request", () => {
    const origin = publicOrigin(
      containerRequest({ host: "jams-web.azurecontainerapps.io", "x-forwarded-proto": "https" }),
      "https://app.jams.example/ignored/path"
    )

    expect(origin).toBe("https://app.jams.example")
  })

  it("keeps working locally, where only the Host header is present", () => {
    const origin = publicOrigin(
      new Request("http://[::]:3000/api/analyses/x/share", { headers: { host: "localhost:3000" } }),
      undefined
    )

    expect(origin).toBe("http://localhost:3000")
  })

  it("ignores a Host header that is not a hostname, and falls back to the request URL", () => {
    const origin = publicOrigin(
      containerRequest({ host: "evil.example/path?x=1", "x-forwarded-proto": "javascript" }),
      undefined
    )

    expect(origin).toBe("http://0.0.0.0:3000")
  })

  it("falls back to the request when the configured origin is malformed", () => {
    const origin = publicOrigin(containerRequest({ host: "jams.test" }), "not a url")

    expect(origin).toBe("http://jams.test")
  })
})
