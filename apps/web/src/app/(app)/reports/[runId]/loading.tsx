import { Skeleton } from "@/components/ui/skeleton"

export default function ReportLoading() {
  return (
    <div className="min-h-screen bg-background">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="mx-auto mt-2 aspect-video w-full max-w-4xl" />
      <Skeleton className="mt-2 h-[200px] w-full" />
      <div className="mx-auto max-w-6xl px-4 py-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
