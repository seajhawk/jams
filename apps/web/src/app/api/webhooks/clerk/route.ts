import { NextResponse } from "next/server"

import { jsonError } from "@/lib/api"
import { drizzleMirrorStore } from "@/lib/clerk/mirror-store"
import {
  applyClerkWebhookEvent,
  clerkWebhookId,
  verifyClerkWebhook,
  WebhookEventInProgressError,
  WebhookVerificationError,
} from "@/lib/clerk/webhook"
import { resolveLimitPolicy } from "@/lib/limits"
import { clientAddress, consumeRateLimit } from "@/lib/rate-limit"
import { readBodyWithLimit } from "@/lib/request-body"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  // Unauthenticated until the signature is checked, so bound the work a caller can cause first.
  // Svix retries on 429 and 413 is never a legitimate Clerk payload.
  const policy = resolveLimitPolicy()
  const limit = await consumeRateLimit("webhook_ip", `ip:${clientAddress(request.headers)}`, { policy })
  if (!limit.allowed) {
    return jsonError("Too many webhook requests", 429, limit.retryAfterSeconds)
  }
  const payload = await readBodyWithLimit(request, policy.requests.webhookMaxBodyBytes)
  if (payload === null) {
    return jsonError("Webhook body too large", 413)
  }

  try {
    const externalId = clerkWebhookId(request.headers)
    if (!externalId) {
      return NextResponse.json({ error: "Missing svix-id header" }, { status: 400 })
    }

    const event = verifyClerkWebhook(payload, request.headers)
    const status = await applyClerkWebhookEvent(event, externalId, drizzleMirrorStore)

    return NextResponse.json({ ok: true, status })
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof WebhookEventInProgressError) {
      return NextResponse.json(
        { error: error.message, status: "processing" },
        { status: 409, headers: { "Retry-After": "5" } }
      )
    }

    throw error
  }
}
