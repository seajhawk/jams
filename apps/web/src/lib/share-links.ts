import { randomBytes } from "crypto"

import type { shareLinks } from "@/db/schema"

export const SHARE_EXPIRY_DAYS = [1, 7, 30] as const
export type ShareExpiryDays = (typeof SHARE_EXPIRY_DAYS)[number]

export function generateShareToken(): string {
  return randomBytes(32).toString("base64url")
}

export function expiryFromNow(days: ShareExpiryDays, now = new Date()): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
}

export function shareUrl(origin: string, token: string): string {
  return new URL(`/share/${token}`, origin).toString()
}

type ShareLinkRow = typeof shareLinks.$inferSelect

export function serializeShareLink(row: ShareLinkRow) {
  return {
    id: row.id,
    run_id: row.runId,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
    last4: row.token.slice(-4),
  }
}
