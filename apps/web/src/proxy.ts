import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server"

import { isPreviewUserAllowed } from "@/lib/preview-access"

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/share/:token",
  "/api/webhooks(.*)",
])

const isPreviewEntryRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  "/__clerk(.*)",
])

// These two handlers authenticate scheduler secrets or platform admins themselves.
// They must remain reachable without a Clerk browser session.
const isMachineRecoveryRoute = createRouteMatcher([
  "/api/admin/watchdog",
  "/api/admin/reconcile",
])

const authenticatedProxy = clerkMiddleware(async (auth, request) => {
  if (isMachineRecoveryRoute(request)) return
  if (process.env.JAMS_PREVIEW_USER_IDS !== undefined && !isPreviewEntryRoute(request)) {
    const { userId } = await auth()
    if (!isPreviewUserAllowed(userId)) {
      const message = "This preview is invitation-only. Sign in with an invited account to continue."
      if (request.nextUrl.pathname.startsWith("/api/")) {
        return NextResponse.json({ error: message }, {
          status: 403,
          headers: { "Cache-Control": "no-store" },
        })
      }
      return new NextResponse(
        '<!doctype html><html lang="en"><head><title>JAMS private preview</title>' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
        `<body><main><h1>JAMS private preview</h1><p>${message}</p>` +
        '<p><a href="/sign-in">Sign in</a> · <a href="/">Return home</a></p></main></body></html>',
        { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
      )
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
