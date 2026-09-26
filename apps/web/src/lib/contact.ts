/**
 * Preview contact and sharing settings (preview readiness review B3, B4, B7). Server-side only.
 */

/** The address preview visitors write to for access or help; null when not configured. */
export function contactEmail(): string | null {
  const value = process.env.JAMS_CONTACT_EMAIL?.trim()
  // A plain address only: it is placed in HTML and mailto links.
  return value && /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/.test(value) ? value : null
}

/** mailto link that asks for preview access, or null when no contact is configured. */
export function requestAccessHref(): string | null {
  const email = contactEmail()
  return email ? `mailto:${email}?subject=${encodeURIComponent("JAMS preview access")}` : null
}

/**
 * When on, valid share links open without sign-in even while the preview is invitation-only.
 * Tokens are long, random, expiring, revocable and noindex. Off by default: Chris decides.
 */
export function publicShareLinksEnabled(): boolean {
  return process.env.JAMS_PUBLIC_SHARE_LINKS === "1"
}

/** Who runs the preview, as named on the privacy and terms pages. */
export function operatorName(): string {
  return process.env.JAMS_OPERATOR_NAME?.trim() || "the JAMS team"
}
