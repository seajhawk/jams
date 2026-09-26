"use client"

import Link from "next/link"
import { useState } from "react"
import { Bookmark } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { FindingSource } from "@/lib/findings"

/** Save what is on screen as a finding; the server recomputes and freezes the numbers. */
export function SaveFindingButton({ source, defaultTitle }: { source: FindingSource; defaultTitle: string }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle)
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle")
  const [error, setError] = useState<string | null>(null)

  if (state === "saved") {
    return (
      <span className="text-xs text-muted-foreground">
        Saved to{" "}
        <Link href="/findings" className="underline">
          Findings
        </Link>
      </span>
    )
  }
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Bookmark data-icon="inline-start" className="size-3.5" />
        Save as finding
      </Button>
    )
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setState("saving")
    setError(null)
    try {
      const response = await fetch("/api/findings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, source }),
      })
      if (!response.ok) {
        throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save")
      }
      setState("saved")
    } catch (caught) {
      // Network failures reject fetch itself; always return to a state the user can retry from.
      setError(caught instanceof Error ? caught.message : "Could not save")
      setState("idle")
    }
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Finding title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="h-8 w-72"
        autoFocus
      />
      <Button size="sm" type="submit" disabled={state === "saving" || !title.trim()}>
        {state === "saving" ? "Saving…" : "Save"}
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </form>
  )
}
