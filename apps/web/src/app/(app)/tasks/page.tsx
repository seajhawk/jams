import { ClipboardList } from "lucide-react"

export const metadata = { title: "Tasks - JAMS" }

export default function TasksPage() {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          Task definitions will become the comparison axis for journeys.
        </p>
      </div>
      <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed bg-background p-8 text-center">
        <div>
          <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
            <ClipboardList className="size-5 text-muted-foreground" />
          </div>
          <h2 className="mt-5 text-lg font-medium">No tasks yet</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Create tasks after the upload workflow lands. Each task will group
            related journeys for comparison.
          </p>
        </div>
      </div>
    </section>
  )
}
