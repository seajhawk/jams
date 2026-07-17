import { Skeleton } from "@/components/ui/skeleton"

export default function CompareLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b px-4 py-4">
        <Skeleton className="h-6 w-40 mb-4" />
        <div className="grid grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <div className="flex items-center gap-4">
                <Skeleton className="size-16 rounded-full shrink-0" />
                <div className="space-y-2 flex-1">
                  {["Physical", "Cognitive", "Time", "Sentiment"].map((c) => (
                    <div key={c} className="flex justify-between">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-3 w-12" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab bar + player */}
      <div className="border-b">
        <div className="flex gap-1 bg-muted p-1 w-fit m-3">
          <Skeleton className="h-7 w-32 rounded-md" />
          <Skeleton className="h-7 w-32 rounded-md" />
        </div>
        <Skeleton className="mx-auto aspect-video w-full max-w-4xl rounded-none" />
      </div>

      {/* Segment bars */}
      <div className="mx-auto max-w-6xl px-4 py-6 space-y-3">
        <Skeleton className="h-5 w-40" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-[65%]" />
            <Skeleton className="h-6 w-[45%]" />
          </div>
        ))}
      </div>

      {/* Kind deltas */}
      <div className="mx-auto max-w-6xl px-4 pb-8 space-y-3">
        <Skeleton className="h-5 w-32" />
        <div className="flex gap-2 flex-wrap">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-28 rounded-full" />
          ))}
        </div>
      </div>
    </div>
  )
}
