'use client'

import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ComparePicker } from '@/components/compare/ComparePicker'

export const dynamic = 'force-dynamic'

interface TaskRecord {
  id: string
  name: string
  description: string | null
  created_at: string
}

function TasksSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-60" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
      ))}
    </div>
  )
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadTasks = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/tasks')
      if (!res.ok) throw new Error('Failed to load tasks')
      const { tasks: rows } = (await res.json()) as { tasks: TaskRecord[] }
      setTasks(rows)
    } catch {
      setError('Failed to load tasks. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTasks()
  }, [loadTasks])

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          Task definitions group related recordings and power cross-run comparisons.
        </p>
      </div>

      {loading && <TasksSkeleton />}

      {!loading && error && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={loadTasks}>
            <RotateCcw data-icon="inline-start" className="size-4" />
            Try again
          </Button>
        </div>
      )}

      {!loading && !error && tasks.length === 0 && (
        <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed bg-background p-8 text-center">
          <div>
            <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-muted">
              <ClipboardList className="size-5 text-muted-foreground" />
            </div>
            <h2 className="mt-5 text-lg font-medium">No tasks yet</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Tasks are created when you upload a video and assign it to a task.
              Each task groups related recordings for comparison.
            </p>
          </div>
        </div>
      )}

      {!loading && !error && tasks.length > 0 && (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{task.name}</p>
                {task.description && (
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {task.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Created {new Date(task.created_at).toLocaleDateString()}
                </p>
              </div>
              <div className="shrink-0">
                <ComparePicker taskId={task.id} taskName={task.name} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
