"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"

type Props = {
  endpoint: string
  label: string
  variant?: "default" | "outline" | "destructive"
}

export function AdminActionButton({
  endpoint,
  label,
  variant = "outline",
}: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runAction() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(endpoint, { method: "POST" })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(body?.error ?? "Action failed")
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={variant}
        disabled={busy}
        onClick={() => void runAction()}
      >
        {busy && <Loader2 data-icon="inline-start" className="size-3 animate-spin" />}
        {label}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
