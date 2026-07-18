import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { HttpError } from "@/lib/api"

export type PlatformAdmin = {
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

export async function requirePlatformAdminApi() {
  const admin = await getPlatformAdmin()
  if (!admin) {
    throw new HttpError(404, "Not found")
  }
  return admin
}

export async function requirePlatformAdminPage() {
  const admin = await getPlatformAdmin()
  if (!admin) {
    notFound()
  }
  return admin
}
