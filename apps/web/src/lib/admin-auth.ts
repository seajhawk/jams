import crypto from "node:crypto"
import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { HttpError } from "@/lib/api"

export type PlatformAdmin = {
  userId: string
}

export type AdminAuthResult = {
  type: "user" | "machine"
  userId: string
}

export function parseAdminUserIds(raw = process.env.ADMIN_USER_IDS ?? "") {
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )
}

export function isAdminUserId(
  userId: string | null | undefined,
  allowlist = parseAdminUserIds()
) {
  return Boolean(userId && allowlist.has(userId))
}

export async function getPlatformAdmin(): Promise<PlatformAdmin | null> {
  const { userId } = await auth()
  return isAdminUserId(userId) && userId ? { userId } : null
}

export function verifyMachineSecret(
  providedSecret: string | null | undefined,
  expectedSecret = process.env.WATCHDOG_SECRET || process.env.CRON_SECRET
): boolean {
  if (!providedSecret || !expectedSecret) {
    return false
  }
  const providedBuffer = Buffer.from(providedSecret)
  const expectedBuffer = Buffer.from(expectedSecret)
  if (providedBuffer.length !== expectedBuffer.length) {
    return false
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer)
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const [scheme, token] = header.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null
  }
  return token
}

export function extractSecretFromRequest(request: Request): string | null {
  return (
    extractBearerToken(request) ??
    request.headers.get("x-watchdog-secret") ??
    request.headers.get("x-cron-secret")
  )
}

export async function requirePlatformAdminApi(): Promise<PlatformAdmin> {
  const admin = await getPlatformAdmin()
  if (!admin) {
    throw new HttpError(404, "Not found")
  }
  return admin
}

export async function requireMachineOrPlatformAdminApi(
  request: Request
): Promise<AdminAuthResult> {
  const secret = extractSecretFromRequest(request)
  if (verifyMachineSecret(secret)) {
    return { type: "machine", userId: "system:watchdog" }
  }

  const admin = await getPlatformAdmin()
  if (admin) {
    return { type: "user", userId: admin.userId }
  }

  throw new HttpError(404, "Not found")
}

export async function requirePlatformAdminPage(): Promise<PlatformAdmin> {
  const admin = await getPlatformAdmin()
  if (!admin) {
    notFound()
  }
  return admin
}
