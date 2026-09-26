"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { BlockBlobClient } from "@azure/storage-blob"
import { toast } from "sonner"
import { AlertCircle, FileVideo, Loader2, Upload, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { formatMs } from "@/lib/format-ms"
import { MAX_VIDEO_SIZE_BYTES } from "@/lib/videos"
import { extractVideoMetadata, type VideoMetadata } from "./useVideoMetadata"

const MAX_DURATION_MS = 20 * 60 * 1000 // 20 min

const ACCEPTED_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
])

type Phase = "idle" | "extracting" | "form" | "uploading"

interface FormState {
  title: string
  taskId: string
  newTaskName: string
  newJourneyGoalId: string
  subjectLabel: string
  cohorts: string
  variantLabel: string
}

interface CatalogJourneyOption {
  id: string
  name: string
}

interface CatalogResponse {
  projects: {
    id: string
    name: string
    goals: { id: string; name: string; journeys: CatalogJourneyOption[] }[]
  }[]
  ungrouped_journeys: CatalogJourneyOption[]
}

interface ParticipantOption {
  id: string
  label: string
  cohorts: string[]
}

interface VariantOption {
  id: string
  name: string
}

interface UploadDialogProps {
  onSuccess?: (videoId: string) => void
  /** Open immediately (the journey page's "Add a session" link). */
  defaultOpen?: boolean
  /** Preselect this journey. */
  initialJourneyId?: string
}

const EMPTY_FORM: FormState = {
  title: "",
  taskId: "",
  newTaskName: "",
  newJourneyGoalId: "",
  subjectLabel: "",
  cohorts: "",
  variantLabel: "",
}

const LAST_JOURNEY_KEY = "jams.upload.lastJourney"

function readLastJourney(): string {
  try {
    return window.localStorage.getItem(LAST_JOURNEY_KEY) ?? ""
  } catch {
    return ""
  }
}

function rememberJourney(id: string) {
  try {
    window.localStorage.setItem(LAST_JOURNEY_KEY, id)
  } catch {
    // Storage can be unavailable (private windows); remembering is only a convenience.
  }
}

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload
}

function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtSpeed(bps: number): string {
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function fmtEta(remaining: number, bps: number): string {
  if (bps <= 0) return "–"
  const s = Math.round(remaining / bps)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function UploadDialog({ onSuccess, defaultOpen = false, initialJourneyId }: UploadDialogProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [phase, setPhase] = useState<Phase>("idle")
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null)
  const [posterObjectUrl, setPosterObjectUrl] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [participantOptions, setParticipantOptions] = useState<ParticipantOption[]>([])
  const [variantOptions, setVariantOptions] = useState<VariantOption[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [progress, setProgress] = useState(0)
  const [transferred, setTransferred] = useState(0)
  const [speedBps, setSpeedBps] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const videoIdRef = useRef<string | null>(null)
  const lastBytesRef = useRef(0)
  const lastTimeRef = useRef(0)

  const reset = useCallback(() => {
    setPhase("idle")
    setDragOver(false)
    setError(null)
    setFile(null)
    setMetadata(null)
    setPosterObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setCatalog(null)
    setVariantOptions([])
    setForm(EMPTY_FORM)
    setProgress(0)
    setTransferred(0)
    setSpeedBps(0)
    videoIdRef.current = null
    abortRef.current = null
    lastBytesRef.current = 0
    lastTimeRef.current = 0
  }, [])

  // Load projects/goals/journeys and participants when the form phase opens, and preselect the
  // requested journey (or the last one used on this browser).
  useEffect(() => {
    if (!open || phase !== "form") return
    fetch("/api/catalog")
      .then((r) => r.json() as Promise<CatalogResponse>)
      .then((data) => {
        setCatalog(data)
        const known = new Set([
          ...data.projects.flatMap((p) => p.goals.flatMap((g) => g.journeys.map((j) => j.id))),
          ...data.ungrouped_journeys.map((j) => j.id),
        ])
        const preferred = initialJourneyId ?? readLastJourney()
        if (preferred && known.has(preferred)) {
          setForm((f) => (f.taskId ? f : { ...f, taskId: preferred }))
        }
      })
      .catch(() => {})
    fetch("/api/participants")
      .then((r) => r.json() as Promise<{ participants: ParticipantOption[] }>)
      .then(({ participants }) => setParticipantOptions(participants))
      .catch(() => {})
  }, [open, phase, initialJourneyId])

  // Variants belong to a journey; offer the chosen journey's existing ones.
  useEffect(() => {
    if (!form.taskId || form.taskId === "__new__") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVariantOptions([])
      return
    }
    fetch(`/api/variants?task_id=${form.taskId}`)
      .then((r) => r.json() as Promise<{ variants: VariantOption[] }>)
      .then(({ variants }) => setVariantOptions(variants ?? []))
      .catch(() => setVariantOptions([]))
  }, [form.taskId])

  const goalOptions = (catalog?.projects ?? []).flatMap((project) =>
    project.goals.map((goal) => ({ id: goal.id, label: `${project.name} › ${goal.name}` }))
  )
  const knownParticipant = participantOptions.find(
    (p) => p.label.toLowerCase() === form.subjectLabel.trim().toLowerCase()
  )

  async function processFile(f: File) {
    setError(null)

    if (!ACCEPTED_TYPES.has(f.type)) {
      setError("Unsupported file type. Please use MP4, MOV, WebM, or M4V.")
      return
    }
    if (f.size > MAX_VIDEO_SIZE_BYTES) {
      setError("File exceeds the 2 GiB limit. Please compress or trim it first.")
      return
    }

    setPhase("extracting")
    try {
      const meta = await extractVideoMetadata(f)
      if (meta.durationMs > MAX_DURATION_MS) {
        setError(
          "Video exceeds the 20-minute limit. Please trim it before uploading."
        )
        setPhase("idle")
        return
      }
      setFile(f)
      setMetadata(meta)
      setPosterObjectUrl(URL.createObjectURL(meta.posterBlob))
      setForm((prev) => ({ ...prev, title: f.name.replace(/\.[^.]+$/, "") }))
      setPhase("form")
    } catch {
      setError("Could not read the video file. Please try a different file.")
      setPhase("idle")
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }
  function handleDragLeave() {
    setDragOver(false)
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) processFile(f)
  }
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) processFile(f)
    e.target.value = ""
  }

  async function handleUpload() {
    if (!file || !metadata) return

    setPhase("uploading")
    setProgress(0)
    setTransferred(0)
    lastBytesRef.current = 0
    lastTimeRef.current = Date.now()

    const controller = new AbortController()
    abortRef.current = controller

    try {
      // 1. Resolve the journey, creating it (under the chosen goal) if asked
      let resolvedTaskId: string | undefined
      if (form.taskId === "__new__" && form.newTaskName.trim()) {
        const { task } = await postJson<{ task: { id: string } }>(
          "/api/tasks",
          {
            name: form.newTaskName.trim(),
            ...(form.newJourneyGoalId ? { goal_id: form.newJourneyGoalId } : {}),
          },
          controller.signal
        )
        resolvedTaskId = task.id
      } else if (form.taskId && form.taskId !== "__new__") {
        resolvedTaskId = form.taskId
      }
      if (resolvedTaskId) rememberJourney(resolvedTaskId)

      // 1b. Resolve the participant and variant, reusing existing records before creating
      let participantId: string | undefined
      const participantLabel = form.subjectLabel.trim()
      if (participantLabel) {
        const match = participantOptions.find(
          (p) => p.label.toLowerCase() === participantLabel.toLowerCase()
        )
        if (match) {
          participantId = match.id
        } else {
          const cohorts = form.cohorts
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
          const { participant } = await postJson<{ participant: { id: string } }>(
            "/api/participants",
            { label: participantLabel, cohorts },
            controller.signal
          )
          participantId = participant.id
        }
      }
      let variantId: string | undefined
      const variantName = form.variantLabel.trim()
      if (variantName && resolvedTaskId) {
        const existing = variantOptions.find((v) => v.name === variantName)
        if (existing) {
          variantId = existing.id
        } else {
          const { variant } = await postJson<{ variant: { id: string } }>(
            "/api/variants",
            { task_id: resolvedTaskId, name: variantName },
            controller.signal
          )
          variantId = variant.id
        }
      }

      // 2. Create the video row + mint SAS URLs
      const createRes = await fetch("/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim() || file.name,
          filename: file.name,
          content_type: file.type,
          size_bytes: file.size,
          ...(resolvedTaskId ? { task_id: resolvedTaskId } : {}),
          ...(form.subjectLabel.trim()
            ? { subject_label: form.subjectLabel.trim() }
            : {}),
          ...(form.variantLabel.trim()
            ? { variant_label: form.variantLabel.trim() }
            : {}),
          ...(participantId ? { participant_id: participantId } : {}),
          ...(variantId ? { variant_id: variantId } : {}),
        }),
        signal: controller.signal,
      })
      const createBody = (await createRes.json()) as {
        video_id?: string
        upload?: { url: string }
        poster_upload?: { url: string }
        error?: string
      }
      if (!createRes.ok)
        throw new Error(createBody.error ?? "Failed to start upload")

      const { video_id, upload, poster_upload } = createBody as {
        video_id: string
        upload: { url: string }
        poster_upload: { url: string }
      }
      videoIdRef.current = video_id

      // 3. Upload poster via a plain PUT (small JPEG, no block splitting needed)
      await fetch(poster_upload.url, {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "Content-Type": "image/jpeg",
        },
        body: metadata.posterBlob,
        signal: controller.signal,
      })

      // 4. Upload the video file via BlockBlobClient (multipart, with progress)
      const blockBlobClient = new BlockBlobClient(upload.url)
      const totalBytes = file.size

      await blockBlobClient.uploadData(file, {
        blockSize: 4 * 1024 * 1024,
        concurrency: 4,
        abortSignal: controller.signal,
        onProgress: (ev) => {
          const loaded = ev.loadedBytes
          const now = Date.now()
          const elapsed = (now - lastTimeRef.current) / 1000
          if (elapsed >= 0.5) {
            setSpeedBps((loaded - lastBytesRef.current) / elapsed)
            lastBytesRef.current = loaded
            lastTimeRef.current = now
          }
          setTransferred(loaded)
          setProgress(Math.min(99, Math.round((loaded / totalBytes) * 100)))
        },
        blobHTTPHeaders: { blobContentType: file.type },
      })

      setProgress(100)

      // 5. Mark as complete with client-extracted metadata
      await fetch(`/api/videos/${video_id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          duration_ms: metadata.durationMs,
          width: metadata.width,
          height: metadata.height,
          has_audio: metadata.hasAudio,
          poster_uploaded: true,
        }),
      })

      toast.success("Video uploaded — it will appear in your library shortly.")
      const vid = video_id
      reset()
      setOpen(false)
      onSuccess?.(vid)
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        // User cancelled — mark the row as failed so it doesn't stay "uploading"
        const vid = videoIdRef.current
        if (vid) {
          fetch(`/api/videos/${vid}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ failed: true }),
          }).catch(() => {})
        }
        reset()
        setOpen(false)
        return
      }
      const msg =
        err instanceof Error ? err.message : "Upload failed. Please try again."
      toast.error(msg)
      setError(msg)
      setPhase("form")
    }
  }

  function handleCancel() {
    abortRef.current?.abort()
  }

  function handleOpenChange(o: boolean) {
    if (!o && phase === "uploading") return // block close during upload
    if (!o) reset()
    setOpen(o)
  }

  const totalSizeLabel = file ? fmt(file.size) : "0 B"

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        data-testid="upload-file-input"
        accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm,video/x-m4v"
        className="hidden"
        onChange={handleFileChange}
      />

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger render={<Button />}>
          <Upload data-icon="inline-start" className="size-4" />
          Upload journey
        </DialogTrigger>

        <DialogContent
          className="sm:max-w-2xl"
          showCloseButton={phase !== "uploading"}
        >
          <DialogHeader>
            <DialogTitle>
              {phase === "uploading"
                ? "Uploading…"
                : "Upload a journey video"}
            </DialogTitle>
          </DialogHeader>

          {/* ── Drop zone (idle / extracting) ── */}
          {(phase === "idle" || phase === "extracting") && (
            <div className="space-y-4">
              <div
                role="button"
                tabIndex={0}
                className={cn(
                  "flex min-h-48 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors",
                  dragOver
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-muted/30"
                )}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    fileInputRef.current?.click()
                }}
              >
                {phase === "extracting" ? (
                  <>
                    <Loader2 className="size-8 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Reading video…
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex size-12 items-center justify-center rounded-md bg-muted">
                      <FileVideo className="size-6 text-muted-foreground" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium">
                        Drag a video here or click to browse
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        MP4, MOV, WebM, M4V · max 20 min / 2 GiB
                      </p>
                    </div>
                  </>
                )}
              </div>
              <ErrorBox message={error} />
            </div>
          )}

          {/* ── Form (metadata + fields) ── */}
          {phase === "form" && metadata && (
            <div className="space-y-5">
              <ErrorBox message={error} />

              <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
                {/* Poster preview */}
                {posterObjectUrl && (
                  <div className="mx-auto w-full sm:w-44">
                    <div className="relative aspect-video overflow-hidden rounded-md border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={posterObjectUrl}
                        alt="Video preview"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <p className="mt-1 text-center text-xs text-muted-foreground">
                      {formatMs(metadata.durationMs)} ·{" "}
                      {(file!.size / (1024 * 1024)).toFixed(0)} MB
                    </p>
                  </div>
                )}

                {/* Fields */}
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="upload-title">Title</Label>
                    <Input
                      id="upload-title"
                      value={form.title}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, title: e.target.value }))
                      }
                      placeholder="Give this journey a title"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="upload-task">Journey</Label>
                    <select
                      id="upload-task"
                      value={form.taskId}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, taskId: e.target.value }))
                      }
                      className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">Not filed under a journey</option>
                      <option value="__new__">＋ New journey…</option>
                      {(catalog?.projects ?? []).flatMap((project) =>
                        project.goals.map((goal) => (
                          <optgroup key={goal.id} label={`${project.name} › ${goal.name}`}>
                            {goal.journeys.map((journey) => (
                              <option key={journey.id} value={journey.id}>
                                {journey.name}
                              </option>
                            ))}
                          </optgroup>
                        ))
                      )}
                      {(catalog?.ungrouped_journeys.length ?? 0) > 0 && (
                        <optgroup label="Without a goal">
                          {catalog!.ungrouped_journeys.map((journey) => (
                            <option key={journey.id} value={journey.id}>
                              {journey.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    {form.taskId === "__new__" && (
                      <div className="space-y-1.5">
                        <Input
                          data-testid="new-task-name"
                          placeholder="How they do it, e.g. Deploy from VS Code"
                          value={form.newTaskName}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              newTaskName: e.target.value,
                            }))
                          }
                          autoFocus
                        />
                        {goalOptions.length > 0 && (
                          <select
                            aria-label="Goal for the new journey"
                            value={form.newJourneyGoalId}
                            onChange={(e) => setForm((f) => ({ ...f, newJourneyGoalId: e.target.value }))}
                            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            <option value="">No goal yet</option>
                            {goalOptions.map((goal) => (
                              <option key={goal.id} value={goal.id}>
                                {goal.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="upload-subject">
                      Participant{" "}
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </Label>
                    <Input
                      id="upload-subject"
                      value={form.subjectLabel}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          subjectLabel: e.target.value,
                        }))
                      }
                      placeholder="Who performed it? e.g. P03 (no names needed)"
                      list="upload-participant-options"
                    />
                    <datalist id="upload-participant-options">
                      {participantOptions.map((p) => (
                        <option key={p.id} value={p.label}>
                          {p.cohorts.join(", ")}
                        </option>
                      ))}
                    </datalist>
                    {form.subjectLabel.trim() && !knownParticipant && (
                      <Input
                        aria-label="Cohorts for the new participant"
                        value={form.cohorts}
                        onChange={(e) => setForm((f) => ({ ...f, cohorts: e.target.value }))}
                        placeholder="Cohorts, comma separated: beginner, admin"
                      />
                    )}
                    {knownParticipant && knownParticipant.cohorts.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Cohorts: {knownParticipant.cohorts.join(", ")}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="upload-variant">
                      Variant{" "}
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    </Label>
                    <Input
                      id="upload-variant"
                      value={form.variantLabel}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          variantLabel: e.target.value,
                        }))
                      }
                      placeholder="Version being compared, e.g. B or build 2026.09.2"
                      list="upload-variant-options"
                    />
                    <datalist id="upload-variant-options">
                      {variantOptions.map((v) => (
                        <option key={v.id} value={v.name} />
                      ))}
                    </datalist>
                  </div>
                </div>
              </div>

              <div className="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end">
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button
                  onClick={handleUpload}
                  disabled={!form.title.trim()}
                >
                  <Upload data-icon="inline-start" className="size-4" />
                  Upload
                </Button>
              </div>
            </div>
          )}

          {/* ── Progress ── */}
          {phase === "uploading" && file && (
            <div className="space-y-5">
              {posterObjectUrl && (
                <div className="flex items-center gap-3">
                  <div className="size-10 shrink-0 overflow-hidden rounded border bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={posterObjectUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {form.title || file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {totalSizeLabel}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{progress}%</span>
                  <span>
                    {fmt(transferred)} of {fmt(file.size)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {speedBps > 0 ? fmtSpeed(speedBps) : "Starting…"}
                  </span>
                  <span>
                    ETA{" "}
                    {speedBps > 0
                      ? fmtEta(file.size - transferred, speedBps)
                      : "–"}
                  </span>
                </div>
              </div>

              <div className="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={handleCancel}>
                  <X data-icon="inline-start" className="size-4" />
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      {message}
    </div>
  )
}
