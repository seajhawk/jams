/**
 * The origin users reach the app on, for links we hand back to them (share links).
 *
 * Not `new URL(request.url).origin`: the standalone production server fills request.url from the
 * address it is bound to, so on Azure Container Apps (HOSTNAME=0.0.0.0) share links came out as
 * http://0.0.0.0:3000/share/..., and in `next dev` they looked fine, so nothing caught it.
 *
 * Order: JAMS_PUBLIC_ORIGIN when configured (a custom domain), then the forwarded host and
 * protocol set by the ingress, then the Host header, then request.url as a last resort. The result
 * is only returned to the signed-in user who made the request, so a forged Host header can only
 * change that user's own response.
 */

const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/

function firstValue(header: string | null): string | null {
  const value = header?.split(",")[0]?.trim()
  return value ? value : null
}

function validHost(host: string | null): string | null {
  return host && HOST_PATTERN.test(host) ? host : null
}

export function publicOrigin(request: Request, configured = process.env.JAMS_PUBLIC_ORIGIN): string {
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // A malformed setting falls through to the request rather than breaking link creation.
    }
  }

  const fallback = new URL(request.url)
  const forwardedHost = validHost(firstValue(request.headers.get("x-forwarded-host")))
  const host = forwardedHost ?? validHost(firstValue(request.headers.get("host")))
  if (!host) return fallback.origin

  const forwardedProto = firstValue(request.headers.get("x-forwarded-proto"))
  const protocol =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : fallback.protocol.replace(/:$/, "")
  return `${protocol}://${host}`
}
