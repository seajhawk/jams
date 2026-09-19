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

type DialogProps = {
  videoId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once the server has accepted the deletion. */
  onDeleted: () => void
  /** Optional trigger; omit when the parent opens the dialog itself (e.g. from a menu). */
  trigger?: React.ReactElement
}

/**
 * Confirm-and-delete for one recording. Controlled, so it can be opened from a dropdown item on a
 * library card as well as from the detail page's button. Deleting removes the recording together
 * with every analysis, report and share link that belongs to it.
 */
export function DeleteRecordingDialog({
  videoId,
  title,
  open,
  onOpenChange,
  onDeleted,
  trigger,
}: DialogProps) {
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

      onOpenChange(false)
      toast.success("Recording removed. Storage cleanup is queued.")
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove recording")
    } finally {
      setDeleting(false)
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (deleting) return
    onOpenChange(nextOpen)
    if (nextOpen) setError(null)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this recording?</DialogTitle>
          <DialogDescription>
            This permanently removes <strong>{title}</strong>, its analyses, reports, and share links.
            Storage cleanup will be queued after deletion. To just tidy it away, archive it instead.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
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

type Props = {
  videoId: string
  title: string
}

/** The detail page's delete control: same dialog, then back to the library. */
export function DeleteRecordingButton({ videoId, title }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <DeleteRecordingDialog
      videoId={videoId}
      title={title}
      open={open}
      onOpenChange={setOpen}
      onDeleted={() => {
        router.replace("/library")
        router.refresh()
      }}
      trigger={
        <Button variant="destructive" size="sm">
          <Trash2 data-icon="inline-start" className="size-4" />
          Delete recording
        </Button>
      }
    />
  )
}
