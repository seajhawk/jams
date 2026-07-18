"use client"

import { useMemo, useState } from "react"
import { Loader2, RotateCcw } from "lucide-react"
import { parse, stringify } from "yaml"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  analysisConfigJsonSchema,
  analysisConfigSchema,
  defaultAnalysisConfig,
  formatAnalysisConfigError,
} from "@/lib/analysis-config"

type AnalysisRunResponse = {
  analysis: {
    id: string
    config?: Record<string, unknown>
    config_source?: string | null
    pipeline_version?: string
    status: string
    superseded_by: string | null
    timestamps: { created_at: string; completed_at: string | null }
  }
}

type Props = {
  videoId: string
  currentConfig?: Record<string, unknown> | null
  currentConfigSource?: string | null
  onCreated(run: AnalysisRunResponse["analysis"]): void
}

function configYaml(config?: Record<string, unknown> | null, source?: string | null) {
  if (source?.trim()) return source
  const parsed = analysisConfigSchema.safeParse(config ?? {})
  return stringify(parsed.success ? parsed.data : defaultAnalysisConfig)
}

export function ReanalyzeDialog({
  videoId,
  currentConfig,
  currentConfigSource,
  onCreated,
}: Props) {
  const initialYaml = useMemo(
    () => configYaml(currentConfig, currentConfigSource),
    [currentConfig, currentConfigSource]
  )
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(initialYaml)
  const [dirty, setDirty] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      setDraft(initialYaml)
      setDirty(false)
      setError(null)
    }
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const requestBody: {
        video_id: string
        config?: unknown
        config_source?: string
      } = { video_id: videoId }

      if (dirty) {
        let parsedYaml: unknown
        try {
          parsedYaml = parse(draft)
        } catch (err) {
          throw new Error(err instanceof Error ? err.message : "YAML parse failed")
        }

        const result = analysisConfigSchema.safeParse(parsedYaml)
        if (!result.success) {
          throw new Error(formatAnalysisConfigError(result.error))
        }
        requestBody.config = result.data
        requestBody.config_source = draft
      }

      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(body?.error ?? "Failed to start analysis")
      }

      const body = (await response.json()) as AnalysisRunResponse
      onCreated(body.analysis)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <RotateCcw data-icon="inline-start" className="size-4" />
        Re-analyze
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Re-analyze video</DialogTitle>
          <DialogDescription>
            Start a new run for this recording.
          </DialogDescription>
        </DialogHeader>

        <details className="rounded-md border bg-muted/30 p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 space-y-3">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Analysis config YAML</span>
              <textarea
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setDirty(true)
                  setError(null)
                }}
                className="min-h-60 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                spellCheck={false}
              />
            </label>
            <details>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                JSON Schema
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-background p-3 text-xs">
                {JSON.stringify(analysisConfigJsonSchema, null, 2)}
              </pre>
            </details>
          </div>
        </details>

        {error && (
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </pre>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && (
              <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            )}
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
