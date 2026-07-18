import { NextResponse } from "next/server"

import { drizzleMirrorStore } from "@/lib/clerk/mirror-store"
import {
  applyClerkWebhookEvent,
  clerkWebhookId,
  verifyClerkWebhook,
  WebhookVerificationError,
} from "@/lib/clerk/webhook"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const payload = await request.text()

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

    throw error
  }
}
