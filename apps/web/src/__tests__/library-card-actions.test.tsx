import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@testing-library/jest-dom/vitest"

import { LibraryContent } from "@/components/upload/LibraryContent"

const routerMocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))
const searchState = vi.hoisted(() => ({ query: "" }))
const toastMocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(searchState.query),
}))

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

vi.mock("@/components/upload/UploadDialog", () => ({
  UploadDialog: () => <button type="button">Upload journey</button>,
}))

vi.mock("sonner", () => toastMocks)

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

type Run = { id: string; status: string }

const baseVideo = {
  id: "video-1",
  task_id: null,
  task_name: null,
  title: "Checkout walkthrough",
  blob_path: "org/video-1/original.mp4",
  poster_blob_path: null,
  size_bytes: 1234,
  content_type: "video/mp4",
  duration_ms: 120_000,
  width: 640,
  height: 360,
  fps: 30,
  has_audio: true,
  subject_label: null,
  variant_label: null,
  status: "uploaded" as const,
  uploaded_by: "user-1",
  archived_at: null,
  created_at: "2026-09-11T00:00:00.000Z",
}

const video = (latest_run: Run | null = null, overrides: Record<string, unknown> = {}) => ({
  ...baseVideo,
  ...overrides,
  latest_run,
})

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    video_id: "video-1",
    status: "running",
    stage: "transcription",
    progress_pct: 42,
    stage_detail: "Transcribing narration",
    error_code: null,
    ...overrides,
  }
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

type World = {
  videos: ReturnType<typeof video>[]
  archivedCount: number
  /** Successive answers for GET /api/analyses/run-1; the last one repeats. */
  polls: ReturnType<typeof analysis>[]
  startResponse: { status: number; body: unknown }
}

let world: World

function calls(method: string, matcher: (url: string) => boolean) {
  return mockFetch.mock.calls.filter(
    ([url, init]) => matcher(String(url)) && ((init as RequestInit | undefined)?.method ?? "GET") === method
  )
}

function installWorld() {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"

    if (url.startsWith("/api/videos?")) {
      return json({ videos: world.videos, archived_count: world.archivedCount })
    }
    if (url === "/api/tasks") return json({ tasks: [] })
    if (url === "/api/analyses" && method === "POST") {
      return json(world.startResponse.body, world.startResponse.status)
    }
    if (/^\/api\/analyses\/run-1$/.test(url)) {
      const next = world.polls.length > 1 ? world.polls.shift()! : world.polls[0]
      return json({ analysis: next })
    }
    if (/^\/api\/videos\/video-1$/.test(url) && (method === "PATCH" || method === "DELETE")) {
      return json(method === "DELETE" ? { deletion: { status: "cleanup_pending" } } : { video: {} }, method === "DELETE" ? 202 : 200)
    }
    return Promise.resolve(new Response("{}", { status: 404 }))
  })
}

/** Lets pending promises and any due timers run inside act, so state updates land. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function renderLibrary() {
  render(<LibraryContent />)
  await settle()
}

/** A plain click opens Base UI's menu in jsdom; the short settle lets its open animation flush. */
async function openActions(title: string) {
  const trigger = screen.getByRole("button", { name: `Actions for ${title}` })
  fireEvent.click(trigger)
  await settle(50)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  searchState.query = ""
  world = {
    videos: [video()],
    archivedCount: 0,
    polls: [analysis()],
    startResponse: {
      status: 201,
      body: { analysis: analysis({ status: "queued", progress_pct: 0, stage: "queued", stage_detail: null }) },
    },
  }
  installWorld()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a recording with no analysis", () => {
  it("offers both Analyze and Play", async () => {
    await renderLibrary()

    expect(screen.getByRole("button", { name: /analyze/i })).toBeEnabled()
    expect(screen.getByRole("link", { name: /play/i })).toHaveAttribute("href", "/library/video-1")
  })

  it("cannot play or analyze a recording that has not finished uploading", async () => {
    world.videos = [video(null, { status: "uploading" })]
    await renderLibrary()

    expect(screen.getByRole("button", { name: /analyze/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /play/i })).toBeDisabled()
    expect(screen.queryByRole("link", { name: /play/i })).not.toBeInTheDocument()
  })
})

describe("analyzing from the library", () => {
  it("shows progress as an overlay on the card instead of navigating away", async () => {
    await renderLibrary()

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }))
    await settle()

    const overlay = screen.getByTestId("analysis-overlay")
    expect(within(overlay).getByText("42%")).toBeInTheDocument()
    expect(within(overlay).getByText("Transcribing narration")).toBeInTheDocument()
    expect(within(overlay).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42")
    // The old flow pushed to the detail page. Staying put is the point.
    expect(routerMocks.push).not.toHaveBeenCalled()
    expect(calls("POST", (u) => u === "/api/analyses")).toHaveLength(1)
  })

  it("does not let the card be opened or re-analyzed while it is running", async () => {
    await renderLibrary()

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }))
    await settle()

    // The overlay sits on top of the poster and title, and the button underneath is locked.
    expect(screen.getByTestId("analysis-overlay")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /analyze/i })).toBeDisabled()
  })

  it("says the run is queued before a worker picks it up", async () => {
    world.polls = [analysis({ status: "queued", progress_pct: 0, stage: "queued", stage_detail: null })]
    await renderLibrary()

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }))
    await settle()

    expect(screen.getByText(/queued/i)).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
  })

  it("advances as the analysis progresses", async () => {
    world.polls = [analysis({ progress_pct: 10 }), analysis({ progress_pct: 55, stage_detail: "Detecting context switches" })]
    await renderLibrary()

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }))
    await settle()
    expect(screen.getByText("10%")).toBeInTheDocument()

    await settle(2500)

    expect(screen.getByText("55%")).toBeInTheDocument()
    expect(screen.getByText("Detecting context switches")).toBeInTheDocument()
  })

  it("clears the overlay and offers the report once the analysis succeeds", async () => {
    world.polls = [analysis({ progress_pct: 80 }), analysis({ status: "succeeded", progress_pct: 100, stage: "scoring" })]
    await renderLibrary()
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }))
    await settle()

    // The refreshed list reflects the finished run.
    world.videos = [video({ id: "run-1", status: "succeeded" })]
    await settle(2500)

    expect(screen.queryByTestId("analysis-overlay")).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /view report/i })).toHaveAttribute("href", "/reports/run-1")
    expect(toastMocks.toast.success).toHaveBeenCalledWith(
      expect.stringContaining("Checkout walkthrough"),
      expect.objectContaining({ action: expect.objectContaining({ label: "View report" }) })
    )
  })

  it("keeps a failed run on screen with Retry and Dismiss, and explains why", async () => {
    world.polls = [analysis({ status: "failed", progress_pct: 30, error_code: "corrupt_file" })]
    await renderLibrary()

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }))
    await settle()

    const overlay = screen.getByTestId("analysis-overlay")
    expect(within(overlay).getByText(/could not read this video file/i)).toBeInTheDocument()
    expect(within(overlay).getByRole("button", { name: /retry/i })).toBeInTheDocument()

    fireEvent.click(within(overlay).getByRole("button", { name: /dismiss/i }))
    await settle()
    expect(screen.queryByTestId("analysis-overlay")).not.toBeInTheDocument()
  })

  it("shows the server's reason when an analysis cannot be started", async () => {
    world.startResponse = { status: 429, body: { error: "Preview concurrent analysis limit reached" } }
    await renderLibrary()

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }))
    await settle()

    expect(screen.getByText("Preview concurrent analysis limit reached")).toBeInTheDocument()
    expect(screen.queryByTestId("analysis-overlay")).not.toBeInTheDocument()
  })

  it("picks up an analysis that was already running when the page loaded", async () => {
    world.videos = [video({ id: "run-1", status: "running" })]
    world.polls = [analysis({ progress_pct: 67 })]

    await renderLibrary()

    expect(within(screen.getByTestId("analysis-overlay")).getByText("67%")).toBeInTheDocument()
  })

  it("keeps trying, and says so, if the status endpoint is briefly unavailable", async () => {
    world.videos = [video({ id: "run-1", status: "running" })]
    const original = mockFetch.getMockImplementation()!
    let failures = 1
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/analyses/run-1" && failures-- > 0) return Promise.reject(new Error("offline"))
      return original(url, init)
    })

    await renderLibrary()
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument()

    await settle(2500)

    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument()
    expect(screen.getByText("42%")).toBeInTheDocument()
  })
})

describe("archiving and deleting from the library", () => {
  it("archives a recording, removes it from the view, and offers Undo", async () => {
    await renderLibrary()

    await openActions("Checkout walkthrough")
    world.videos = []
    world.archivedCount = 1
    fireEvent.click(screen.getByRole("menuitem", { name: /archive/i }))
    await settle()

    const patches = calls("PATCH", (u) => u === "/api/videos/video-1")
    expect(patches).toHaveLength(1)
    expect(JSON.parse((patches[0][1] as RequestInit).body as string)).toEqual({ archived: true })
    expect(screen.queryByTestId("video-card")).not.toBeInTheDocument()
    expect(toastMocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("Checkout walkthrough"),
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
    )
  })

  it("Undo restores the recording", async () => {
    await renderLibrary()
    await openActions("Checkout walkthrough")
    world.videos = []
    world.archivedCount = 1
    fireEvent.click(screen.getByRole("menuitem", { name: /archive/i }))
    await settle()

    const options = toastMocks.toast.mock.calls[0][1] as { action: { onClick: () => void } }
    world.videos = [video()]
    world.archivedCount = 0
    await act(async () => {
      options.action.onClick()
      await vi.advanceTimersByTimeAsync(0)
    })

    const patches = calls("PATCH", (u) => u === "/api/videos/video-1")
    expect(JSON.parse((patches[1][1] as RequestInit).body as string)).toEqual({ archived: false })
    expect(screen.getByTestId("video-card")).toBeInTheDocument()
  })

  it("leaves the recording in place and says so if archiving fails", async () => {
    await renderLibrary()
    const original = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === "PATCH" ? json({ error: "nope" }, 500) : original(url, init)
    )

    await openActions("Checkout walkthrough")
    fireEvent.click(screen.getByRole("menuitem", { name: /archive/i }))
    await settle()

    expect(screen.getByTestId("video-card")).toBeInTheDocument()
    expect(toastMocks.toast.error).toHaveBeenCalledWith(expect.stringMatching(/could not archive/i))
  })

  it("asks for confirmation before deleting, then removes the recording", async () => {
    await renderLibrary()

    await openActions("Checkout walkthrough")
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }))
    await settle()

    // Nothing has been deleted yet: the dialog is the confirmation step.
    expect(calls("DELETE", (u) => u === "/api/videos/video-1")).toHaveLength(0)
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/permanently removes/i)).toBeInTheDocument()

    world.videos = []
    fireEvent.click(within(dialog).getByRole("button", { name: /delete recording/i }))
    await settle()

    expect(calls("DELETE", (u) => u === "/api/videos/video-1")).toHaveLength(1)
    expect(screen.queryByTestId("video-card")).not.toBeInTheDocument()
  })

  it("does not delete when the confirmation is cancelled", async () => {
    await renderLibrary()

    await openActions("Checkout walkthrough")
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }))
    const dialog = screen.getByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }))
    await settle()

    expect(calls("DELETE", (u) => u === "/api/videos/video-1")).toHaveLength(0)
    expect(screen.getByTestId("video-card")).toBeInTheDocument()
  })

  it("can still archive or delete a recording whose analysis is running", async () => {
    world.videos = [video({ id: "run-1", status: "running" })]
    await renderLibrary()
    expect(screen.getByTestId("analysis-overlay")).toBeInTheDocument()

    await openActions("Checkout walkthrough")

    expect(screen.getByRole("menuitem", { name: /archive/i })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument()
  })
})

describe("the archived view", () => {
  it("does not offer the Archived toggle until something is archived", async () => {
    await renderLibrary()

    expect(screen.queryByRole("button", { name: /archived/i })).not.toBeInTheDocument()
  })

  it("shows how many recordings are archived", async () => {
    world.archivedCount = 4
    await renderLibrary()

    expect(screen.getByRole("button", { name: /archived \(4\)/i })).toBeInTheDocument()
  })

  it("says everything is archived instead of pitching a first upload", async () => {
    world.videos = []
    world.archivedCount = 2
    await renderLibrary()

    expect(screen.getByText(/everything is archived/i)).toBeInTheDocument()
    expect(screen.queryByText(/upload your first journey/i)).not.toBeInTheDocument()
  })

  it("still pitches a first upload when nothing exists at all", async () => {
    world.videos = []
    await renderLibrary()

    expect(screen.getByText(/upload your first journey/i)).toBeInTheDocument()
  })

  it("requests archived recordings and offers Restore instead of Archive", async () => {
    searchState.query = "view=archived"
    world.videos = [video(null, { archived_at: "2026-09-19T10:00:00.000Z" })]
    world.archivedCount = 1
    await renderLibrary()

    expect(calls("GET", (u) => u.includes("archived=archived"))).not.toHaveLength(0)

    await openActions("Checkout walkthrough")

    expect(screen.getByRole("menuitem", { name: /restore to library/i })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /^archive$/i })).not.toBeInTheDocument()
  })

  it("has a way back when the archive is empty", async () => {
    searchState.query = "view=archived"
    world.videos = []
    world.archivedCount = 0
    await renderLibrary()

    expect(screen.getByText(/no archived recordings/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /back to library/i }))
    expect(routerMocks.push).toHaveBeenCalledWith("/library?")
  })

  it("switches views without losing the other filters", async () => {
    searchState.query = "task_id=abc"
    world.archivedCount = 2
    await renderLibrary()

    fireEvent.click(screen.getByRole("button", { name: /archived \(2\)/i }))

    expect(routerMocks.push).toHaveBeenCalledWith(expect.stringMatching(/task_id=abc/))
    expect(routerMocks.push).toHaveBeenCalledWith(expect.stringMatching(/view=archived/))
  })
})
