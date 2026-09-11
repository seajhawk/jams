import { beforeEach, describe, expect, it, vi } from "vitest"

import { POST } from "@/app/api/webhooks/clerk/route"
import { WebhookEventInProgressError, WebhookVerificationError } from "@/lib/clerk/webhook"

const mocks = vi.hoisted(() => ({
  verifyClerkWebhook: vi.fn(),
  applyClerkWebhookEvent: vi.fn(),
}))

vi.mock("@/lib/clerk/webhook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clerk/webhook")>()
  return {
    ...actual,
    verifyClerkWebhook: mocks.verifyClerkWebhook,
    applyClerkWebhookEvent: mocks.applyClerkWebhookEvent,
  }
})

vi.mock("@/lib/clerk/mirror-store", () => ({
  drizzleMirrorStore: {},
}))

describe("Clerk webhook route handler (POST /api/webhooks/clerk)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 400 when svix-id header is missing", async () => {
    const request = new Request("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
    const json = await response.json()
    expect(json).toEqual({ error: "Missing svix-id header" })
  })

  it("returns 400 when webhook signature verification fails", async () => {
    mocks.verifyClerkWebhook.mockImplementation(() => {
      throw new WebhookVerificationError("Invalid Clerk webhook signature")
    })

    const request = new Request("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_invalid",
      },
      body: JSON.stringify({}),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
    const json = await response.json()
    expect(json).toEqual({ error: "Invalid Clerk webhook signature" })
  })

  it("returns 409 Conflict with Retry-After header when event is in progress", async () => {
    mocks.verifyClerkWebhook.mockReturnValue({
      type: "user.created",
      data: { id: "user_test" },
    })
    mocks.applyClerkWebhookEvent.mockRejectedValue(
      new WebhookEventInProgressError("msg_in_prog")
    )

    const request = new Request("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_in_prog",
      },
      body: JSON.stringify({}),
    })

    const response = await POST(request)
    expect(response.status).toBe(409)
    expect(response.headers.get("Retry-After")).toBe("5")
    const json = await response.json()
    expect(json).toMatchObject({
      error: "Webhook event msg_in_prog is currently being processed",
      status: "processing",
    })
  })

  it("returns 200 with status: processed on successful processing", async () => {
    mocks.verifyClerkWebhook.mockReturnValue({
      type: "user.created",
      data: { id: "user_test" },
    })
    mocks.applyClerkWebhookEvent.mockResolvedValue("processed")

    const request = new Request("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_ok",
      },
      body: JSON.stringify({}),
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toEqual({ ok: true, status: "processed" })
  })

  it("returns 200 with status: duplicate for completed events", async () => {
    mocks.verifyClerkWebhook.mockReturnValue({
      type: "user.created",
      data: { id: "user_test" },
    })
    mocks.applyClerkWebhookEvent.mockResolvedValue("duplicate")

    const request = new Request("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_dup",
      },
      body: JSON.stringify({}),
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toEqual({ ok: true, status: "duplicate" })
  })

  it("re-throws unexpected errors so they are not swallowed", async () => {
    mocks.verifyClerkWebhook.mockReturnValue({
      type: "user.created",
      data: { id: "user_test" },
    })
    mocks.applyClerkWebhookEvent.mockRejectedValue(new Error("Database connection lost"))

    const request = new Request("http://localhost:3000/api/webhooks/clerk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_crash",
      },
      body: JSON.stringify({}),
    })

    await expect(POST(request)).rejects.toThrow("Database connection lost")
  })
})
