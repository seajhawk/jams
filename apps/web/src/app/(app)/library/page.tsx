import { ArrowRight, FileVideo, Upload } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export const metadata = { title: "Library - JAMS" }

export default function LibraryPage() {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Library</h1>
        <p className="text-sm text-muted-foreground">
          Upload your first journey to build an effort report from video.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed bg-background p-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-md bg-muted">
            <Upload className="size-5 text-muted-foreground" />
          </div>
          <h2 className="mt-5 text-lg font-medium">Upload your first journey</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Add a screen recording with narration. JAMS will turn it into
            timestamped effort, sentiment, and task-flow measures.
          </p>
          <Button className="mt-5" disabled>
            Upload journey
          </Button>
        </div>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Sample report</CardTitle>
            <CardDescription>
              Review the seeded report while uploads are being built.
            </CardDescription>
            <CardAction>
              <FileVideo className="size-5 text-muted-foreground" />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-sm font-medium">Google Video Analyzer setup</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Interactive timeline, transcript, sentiment, and score
                breakdown.
              </p>
            </div>
            <Button variant="outline" render={<Link href="/demo/report" />}>
              Open sample report
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
