import { ArrowRight, BarChart3, LockKeyhole, Timer } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { contactEmail, requestAccessHref } from "@/lib/contact"

// The preview gate and contact are runtime settings, so render per request.
export const dynamic = "force-dynamic"

export default function Home() {
  // While the preview is invitation-only, a new visitor's next step is asking for access, not a
  // sign-up that the gate would refuse (preview review B3).
  const inviteOnly = process.env.JAMS_PREVIEW_USER_IDS !== undefined
  const accessHref = requestAccessHref()
  const email = contactEmail()
  return (
    <main className="min-h-screen bg-background">
      <section className="mx-auto grid min-h-[calc(100vh-4rem)] w-full max-w-6xl content-center gap-10 px-6 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <div className="space-y-8">
          <div className="space-y-4">
            <p className="text-sm font-medium text-muted-foreground">
              Journey and task effort analysis
            </p>
            <h1 className="max-w-2xl text-5xl font-semibold tracking-normal text-foreground md:text-6xl">
              JAMS
            </h1>
            <p className="max-w-xl text-lg leading-8 text-muted-foreground">
              Turn screen-capture journeys into timestamped physical effort,
              cognitive effort, and sentiment measures with reports that jump to
              exact video moments.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {inviteOnly ? (
              accessHref && (
                <Button render={<a href={accessHref} />}>
                  Request access
                  <ArrowRight data-icon="inline-end" />
                </Button>
              )
            ) : (
              <Button render={<Link href="/sign-up" />}>
                Create account
                <ArrowRight data-icon="inline-end" />
              </Button>
            )}
            <Button variant="outline" render={<Link href="/sign-in" />}>
              Sign in
            </Button>
          </div>
          {inviteOnly && (
            <p className="text-sm text-muted-foreground">
              JAMS is in a private preview. Invited people can sign in; everyone else can ask for
              access.
            </p>
          )}
        </div>

        <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm">
          <div className="rounded-md border bg-background p-4">
            <div className="flex items-center gap-3">
              <Timer className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Timestamped measures</p>
                <p className="text-sm text-muted-foreground">
                  Every signal keeps video-aligned start and end times.
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-md border bg-background p-4">
            <div className="flex items-center gap-3">
              <BarChart3 className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Weighted Effort Score</p>
                <p className="text-sm text-muted-foreground">
                  Physical, cognitive, time, and sentiment lanes roll up cleanly.
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-md border bg-background p-4">
            <div className="flex items-center gap-3">
              <LockKeyhole className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Tenant scoped by default</p>
                <p className="text-sm text-muted-foreground">
                  Each signed-in user starts in a hidden personal workspace.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap gap-4 px-6 pb-8 text-sm text-muted-foreground">
        <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
        <Link href="/terms" className="hover:text-foreground">Terms</Link>
        {email && (
          <a href={`mailto:${email}`} className="hover:text-foreground">
            Contact
          </a>
        )}
      </footer>
    </main>
  );
}
