"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Copy, Loader2, Share2, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

type ShareLink = {
  id: string
  run_id: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  last4: string
}

type CreatedShareLink = {
  link: ShareLink
  token: string
  url: string
}

export function ShareReportDialog({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false)
  const [expiryDays, setExpiryDays] = useState("7")
  const [links, setLinks] = useState<ShareLink[]>([])
  const [audience, setAudience] = useState<"invited_accounts" | "anyone_with_link" | null>(null)
  const [created, setCreated] = useState<CreatedShareLink | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(0)
  // Bumped by every create and revoke. The list request starts when the dialog opens, and a
  // quick "Create link" can finish first; without this, the older response then replaced the
  // list and the new link (and its Revoke button) vanished.
  const listVersion = useRef(0)

  const loadLinks = useCallback(async () => {
    const startedAt = listVersion.current
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/analyses/${runId}/share`)
      if (!response.ok) throw new Error("Failed to load share links")
      const body = (await response.json()) as {
        links: ShareLink[]
        audience?: "invited_accounts" | "anyone_with_link"
      }
      setAudience(body.audience ?? null)
      setLinks((current) => {
        if (listVersion.current === startedAt) return body.links
        // A link was created or revoked while this request was in flight. That local change is
        // newer than the response, so keep it and fill in everything else from the server.
        const merged = new Map(body.links.map((link) => [link.id, link]))
        for (const link of current) merged.set(link.id, link)
        return [...merged.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
      })
      setNowMs(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load share links")
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void loadLinks()
  }, [open, loadLinks])

  async function createLink() {
    setCreating(true)
    setCopied(false)
    setCreated(null)
    setError(null)
    try {
      const response = await fetch(`/api/analyses/${runId}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiry_days: Number(expiryDays) }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? "Failed to create share link")
      }
      const body = (await response.json()) as CreatedShareLink
      listVersion.current += 1
      setCreated(body)
      setLinks((current) => [body.link, ...current])
      setNowMs(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create share link")
    } finally {
      setCreating(false)
    }
  }

  async function copyCreatedLink() {
    if (!created || copied) return
    try {
      await navigator.clipboard.writeText(created.url)
      setCopied(true)
    } catch {
      setError("Clipboard copy failed. Select the link and copy it manually.")
    }
  }

  async function revoke(id: string) {
    setRevokingId(id)
    setError(null)
    try {
      const response = await fetch(`/api/share-links/${id}`, { method: "DELETE" })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? "Failed to revoke link")
      }
      const body = (await response.json()) as { link: ShareLink }
      listVersion.current += 1
      setLinks((current) => current.map((link) => (link.id === id ? body.link : link)))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke link")
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <Share2 data-icon="inline-start" className="size-4" />
            Share
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share report</DialogTitle>
          <DialogDescription>
            Create an expiring read-only link for this report.
            {audience === "invited_accounts" &&
              " During the private preview, only people with an invited JAMS account can open it."}
            {audience === "anyone_with_link" && " Anyone with the link can view the report until it expires or you revoke it."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Expires</span>
              <select
                value={expiryDays}
                onChange={(event) => setExpiryDays(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
              >
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
              </select>
            </label>
            <Button disabled={creating} onClick={() => void createLink()}>
              {creating ? (
                <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
              ) : (
                <Share2 data-icon="inline-start" className="size-4" />
              )}
              Create link
            </Button>
          </div>

          {created && (
            <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Copy this link now. The token is only shown once.
              </p>
              <div className="flex gap-2">
                <input
                  data-testid="created-share-url"
                  readOnly
                  value={created.url}
                  className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={copied}
                  onClick={() => void copyCreatedLink()}
                >
                  {copied ? (
                    <Check data-icon="inline-start" className="size-4 text-green-600" />
                  ) : (
                    <Copy data-icon="inline-start" className="size-4" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Existing links</h3>
            {loading && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading links...
              </p>
            )}
            {!loading && links.length === 0 && (
              <p className="text-sm text-muted-foreground">No share links yet.</p>
            )}
            {!loading && links.map((link) => {
              const revoked = link.revoked_at !== null
              const expired = nowMs > 0 && new Date(link.expires_at).getTime() <= nowMs
              return (
                <div
                  key={link.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">...{link.last4}</span>
                      <Badge variant={revoked || expired ? "outline" : "secondary"}>
                        {revoked ? "Revoked" : expired ? "Expired" : "Active"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(link.created_at).toLocaleString()} · Expires{" "}
                      {new Date(link.expires_at).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={revoked || revokingId === link.id}
                    onClick={() => void revoke(link.id)}
                    aria-label="Revoke share link"
                  >
                    {revokingId === link.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </div>
              )
            })}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
