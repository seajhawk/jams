import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server"

import { contactEmail, publicShareLinksEnabled } from "@/lib/contact"
import { isPreviewUserAllowed } from "@/lib/preview-access"

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/share/:token",
  "/privacy",
  "/terms",
  "/api/webhooks(.*)",
])

const isPreviewEntryRoute = createRouteMatcher([
  "/",
  "/privacy",
  "/terms",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  "/__clerk(.*)",
])

const isShareRoute = createRouteMatcher(["/share/:token"])

/** The invitation-only page: still a 403, but styled, with a way to ask for access. */
function previewDeniedPage(message: string) {
  const email = contactEmail()
  const request = email
    ? `<a class="primary" href="mailto:${email}?subject=${encodeURIComponent("JAMS preview access")}">Request access</a>`
    : ""
  const ask = email
    ? `Write to <a href="mailto:${email}">${email}</a> to ask for an invitation.`
    : "If someone invited you, sign in with the email address the invitation was sent to."
  return (
    '<!doctype html><html lang="en"><head><title>JAMS private preview</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#18181b;" +
    "font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}main{max-width:28rem;margin:1.5rem;" +
    "padding:2rem;background:#fff;border:1px solid #e4e4e7;border-radius:.75rem}h1{font-size:1.25rem;margin:0 0 .75rem}" +
    "p{line-height:1.6;color:#52525b}a{color:#18181b}.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}" +
    ".actions a{padding:.5rem .9rem;border:1px solid #d4d4d8;border-radius:.5rem;text-decoration:none;font-size:.9rem}" +
    ".actions a.primary{background:#18181b;color:#fff;border-color:#18181b}small{display:block;margin-top:1.5rem;color:#71717a}" +
    "@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#27272a}" +
    "p{color:#a1a1aa}a{color:#fafafa}.actions a{border-color:#3f3f46}.actions a.primary{background:#fafafa;color:#18181b}}</style>" +
    `</head><body><main><h1>JAMS is in a private preview</h1><p>${message}</p><p>${ask}</p>` +
    `<div class="actions">${request}<a href="/sign-in">Sign in with another account</a><a href="/">Home</a></div>` +
    '<small><a href="/privacy">How JAMS handles your data</a></small></main></body></html>'
  )
}

// These two handlers authenticate scheduler secrets or platform admins themselves.
// They must remain reachable without a Clerk browser session.
const isMachineRecoveryRoute = createRouteMatcher([
  "/api/admin/watchdog",
  "/api/admin/reconcile",
])

const authenticatedProxy = clerkMiddleware(async (auth, request) => {
  if (isMachineRecoveryRoute(request)) return
  const openShare = publicShareLinksEnabled() && isShareRoute(request)
  if (process.env.JAMS_PREVIEW_USER_IDS !== undefined && !isPreviewEntryRoute(request) && !openShare) {
    const { userId } = await auth()
    if (!isPreviewUserAllowed(userId)) {
      const message = "This preview is invitation-only, and this account has not been invited yet."
      if (request.nextUrl.pathname.startsWith("/api/")) {
        return NextResponse.json({ error: message }, {
          status: 403,
          headers: { "Cache-Control": "no-store" },
        })
      }
      return new NextResponse(previewDeniedPage(message), {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      })
    }
  }
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
})

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // Process liveness must work during identity-provider outages and before keys
  // are configured. This exact route serves no tenant or dependency information.
  if (request.nextUrl.pathname === "/api/health/live") return NextResponse.next()
  return authenticatedProxy(request, event)
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|webp|ico|woff2?|ttf|map)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
}
