"use client"

import { useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

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

type Props = {
  videoId: string
  title: string
}

export function DeleteRecordingButton({ videoId, title }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function removeRecording() {
    setDeleting(true)
    setError(null)
    try {
      const response = await fetch(`/api/videos/${videoId}`, { method: "DELETE" })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? "Failed to remove recording")
      }

      setOpen(false)
      toast.success("Recording removed. Storage cleanup is queued.")
      router.replace("/library")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove recording")
    } finally {
      setDeleting(false)
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (deleting) return
    setOpen(nextOpen)
    if (nextOpen) setError(null)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button variant="destructive" size="sm">
            <Trash2 data-icon="inline-start" className="size-4" />
            Delete recording
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this recording?</DialogTitle>
          <DialogDescription>
            This permanently removes <strong>{title}</strong>, its reports, and its share links.
            Storage cleanup will be queued after deletion.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void removeRecording()} disabled={deleting}>
            {deleting && <Loader2 data-icon="inline-start" className="size-4 animate-spin" />}
            {deleting ? "Removing…" : "Delete recording"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
