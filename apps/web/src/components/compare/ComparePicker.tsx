'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { GitCompare, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ScoredRun {
  runId: string
  videoTitle: string
  subjectLabel: string | null
  variantLabel: string | null
  finishedAt: string | null
}

interface VideoApiRecord {
  id: string
  title: string
  subject_label: string | null
  variant_label: string | null
  created_at: string
  latest_run: { id: string; status: string; timestamps?: { completed_at: string | null } } | null
}

interface ComparePickerProps {
  taskId: string
  taskName: string
}

function runLabel(r: ScoredRun): string {
  let label = r.videoTitle
  if (r.subjectLabel) label += ` (${r.subjectLabel})`
  if (r.variantLabel) label += ` — ${r.variantLabel}`
  if (r.finishedAt) {
    label += ` · ${new Date(r.finishedAt).toLocaleDateString()}`
  }
  return label
}

export function ComparePicker({ taskId, taskName }: ComparePickerProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<ScoredRun[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [runA, setRunA] = useState('')
  const [runB, setRunB] = useState('')

  const loadRuns = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch(`/api/videos?task_id=${taskId}`)
      if (!res.ok) throw new Error('Failed to load videos')
      const { videos } = (await res.json()) as { videos: VideoApiRecord[] }
      const scored = videos
        .filter(
          (v) =>
            v.latest_run?.status === 'succeeded' ||
            v.latest_run?.status === 'partial',
        )
        .map((v) => ({
          runId: v.latest_run!.id,
          videoTitle: v.title,
          subjectLabel: v.subject_label,
          variantLabel: v.variant_label,
          finishedAt: v.latest_run?.timestamps?.completed_at ?? v.created_at,
        }))
      setRuns(scored)
      if (scored.length >= 1) setRunA(scored[0].runId)
      if (scored.length >= 2) setRunB(scored[1].runId)
    } catch {
      setFetchError('Failed to load runs. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void loadRuns()
  }, [open, loadRuns])

  function handleCompare() {
    if (!runA || !runB || runA === runB) return
    router.push(`/compare?runs=${runA},${runB}`)
    setOpen(false)
  }

  const canCompare = !loading && runs.length >= 2 && runA && runB && runA !== runB

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <GitCompare className="size-4" />
            Compare runs
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Compare runs — {taskName}</DialogTitle>
          <DialogDescription>
            Select two analyzed recordings from this task to compare side by side.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading runs…
          </div>
        )}

        {!loading && fetchError && (
          <div className="space-y-2 py-2">
            <p className="text-sm text-destructive">{fetchError}</p>
            <Button variant="outline" size="sm" onClick={() => void loadRuns()}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !fetchError && runs.length < 2 && (
          <p className="py-4 text-sm text-muted-foreground">
            This task needs at least 2 analyzed recordings to compare.
          </p>
        )}

        {!loading && !fetchError && runs.length >= 2 && (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <label
                htmlFor="compare-run-a"
                className="text-sm font-medium"
              >
                Run A — Baseline
              </label>
              <select
                id="compare-run-a"
                value={runA}
                onChange={(e) => setRunA(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-ring"
              >
                {runs.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {runLabel(r)}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-1.5">
              <label
                htmlFor="compare-run-b"
                className="text-sm font-medium"
              >
                Run B — Comparison
              </label>
              <select
                id="compare-run-b"
                value={runB}
                onChange={(e) => setRunB(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none focus-visible:border-ring"
              >
                {runs.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {runLabel(r)}
                  </option>
                ))}
              </select>
            </div>

            {runA === runB && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Please select two different runs.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={!canCompare}
            onClick={handleCompare}
          >
            Compare
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
