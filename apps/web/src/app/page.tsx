import { ArrowRight, BarChart3, LockKeyhole, Timer } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <section className="mx-auto grid min-h-screen w-full max-w-6xl content-center gap-10 px-6 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
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
            <Button render={<Link href="/sign-up" />}>
              Create account
              <ArrowRight data-icon="inline-end" />
            </Button>
            <Button variant="outline" render={<Link href="/sign-in" />}>
              Sign in
            </Button>
          </div>
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
    </main>
  );
}
