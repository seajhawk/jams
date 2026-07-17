'use client'

import { useCallback, useState } from "react"
import { AlertTriangle, Loader2, RotateCcw, XCircle } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"

interface PartialBannerProps {
  videoId: string
  warnings: Array<{ code: string; message: string }>
}

export function PartialBanner({ videoId, warnings }: PartialBannerProps) {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryId, setRetryId] = useState<string | null>(null)

  const retry = useCallback(async () => {
    setRetrying(true)
    setError(null)
    try {
      const res = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: videoId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? "Failed to start analysis")
      }
      const body = (await res.json()) as { analysis: { id: string } }
      setRetryId(body.analysis.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis")
    } finally {
      setRetrying(false)
    }
  }, [videoId])

  if (retryId) {
    return (
      <div className="flex items-center gap-3 border-b bg-amber-50 px-4 py-3 dark:bg-amber-950/20">
        <AlertTriangle className="size-4 shrink-0 text-amber-600" />
        <span className="flex-1 text-sm text-amber-800 dark:text-amber-300">
          Re-analysis started.{" "}
          <Link href={`/library`} className="underline underline-offset-2">
            Track progress in Library
          </Link>
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-start gap-3 border-b bg-amber-50 px-4 py-3 dark:bg-amber-950/20">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="flex-1 space-y-1">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          Partial results
        </p>
        {warnings.map((w) => (
          <p key={w.code} className="text-sm text-amber-700 dark:text-amber-400">
            {w.message}
          </p>
        ))}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <Button size="sm" variant="outline" disabled={retrying} onClick={retry}>
        {retrying ? (
          <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
        ) : (
          <RotateCcw data-icon="inline-start" className="size-4" />
        )}
        Re-analyze
      </Button>
    </div>
  )
}

interface FailedRunBannerProps {
  videoId: string
  errorCode: string | null
}

const ERROR_MESSAGES: Record<string, string> = {
  no_audio: "No narration audio was detected in this video.",
  too_long: "This video is over the 20-minute analysis limit.",
  corrupt_file: "The worker could not read this video file.",
  transient: "The worker hit a temporary processing error.",
  unknown: "The worker could not finish this analysis.",
}

export function FailedRunBanner({ videoId, errorCode }: FailedRunBannerProps) {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryId, setRetryId] = useState<string | null>(null)

  const message = ERROR_MESSAGES[errorCode ?? "unknown"] ?? ERROR_MESSAGES.unknown

  const retry = useCallback(async () => {
    setRetrying(true)
    setError(null)
    try {
      const res = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: videoId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? "Failed to start analysis")
      }
      const body = (await res.json()) as { analysis: { id: string } }
      setRetryId(body.analysis.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis")
    } finally {
      setRetrying(false)
    }
  }, [videoId])

  if (retryId) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
        <p className="text-sm text-muted-foreground">
          Re-analysis started.{" "}
          <Link href="/library" className="underline underline-offset-2">
            Track progress in Library
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-6 py-20 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
        <XCircle className="size-7 text-destructive" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Analysis failed</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button disabled={retrying} onClick={retry}>
        {retrying ? (
          <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
        ) : (
          <RotateCcw data-icon="inline-start" className="size-4" />
        )}
        Retry analysis
      </Button>
    </div>
  )
}
