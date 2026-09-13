/**
 * Preview access is deliberately controlled by a server-only allowlist.
 * An unset variable preserves the normal authenticated product behavior.
 */
export function isPreviewUserAllowed(
  userId: string | null | undefined,
  raw = process.env.JAMS_PREVIEW_USER_IDS
): boolean {
  if (raw === undefined) return true
  if (!userId) return false

  const allowedIds = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)

  return allowedIds.includes(userId)
}

export class PreviewAccessError extends Error {
  readonly status = 403

  constructor() {
    super("Preview access is restricted")
    this.name = "PreviewAccessError"
  }
}

export function assertPreviewUserAllowed(
  userId: string | null | undefined,
  raw = process.env.JAMS_PREVIEW_USER_IDS
): void {
  if (!isPreviewUserAllowed(userId, raw)) {
    throw new PreviewAccessError()
  }
}
