import { Skeleton } from "@/components/ui/skeleton"

export default function ReportLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header bar */}
      <Skeleton className="h-14 w-full rounded-none" />

      {/* Video player area */}
      <div className="sticky top-0 z-30 bg-background shadow-sm">
        <Skeleton className="mx-auto aspect-video w-full max-w-4xl rounded-none" />
      </div>

      {/* Timeline bands */}
      <div className="border-b px-4 py-3 space-y-2">
        <Skeleton className="h-5 w-full rounded" />
        <Skeleton className="h-5 w-full rounded" />
        <Skeleton className="h-4 w-[85%] rounded" />
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* Score dial + breakdown row */}
        <div className="flex items-center gap-6">
          <Skeleton className="size-20 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <div className="flex gap-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        </div>

        {/* Tab row */}
        <Skeleton className="h-9 w-64" />

        {/* Transcript rows */}
        <div className="divide-y rounded-md border overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2">
              <Skeleton className="mt-0.5 h-3 w-10 shrink-0" />
              <div className="flex-1 space-y-1">
                <Skeleton className={`h-3 w-${i % 2 === 0 ? "full" : "[80%]"}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
