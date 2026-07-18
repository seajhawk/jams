import { render, screen, act } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@testing-library/jest-dom/vitest"

import { AnalysisStatusPanel } from "@/components/upload/AnalysisStatusPanel"

// We must mock next/navigation since the panel imports from next/link indirectly
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => "/"),
}))

// Mock fetch so we control API responses
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function makeAnalysis(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-aaaa-0000-0000-000000000001",
    video_id: "vid-bbbb-0000-0000-000000000001",
    status: "running" as const,
    stage: "transcription",
    progress_pct: 45,
    stage_detail: "Transcribing…",
    error_code: null,
    attempt: 0,
    superseded_by: null,
    timestamps: {
      created_at: "2026-07-17T12:00:00.000Z",
      updated_at: "2026-07-17T12:00:10.000Z",
      started_at: "2026-07-17T12:00:05.000Z",
      completed_at: null,
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  )
}

describe("AnalysisStatusPanel teasers", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows tallies after poll returns measures", async () => {
    // Initial render with a running analysis
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/measures")) {
        return jsonResponse({
          measures: [
            {
              id: "m1",
              kind: "context_switch",
              t_start_ms: 1000,
              value_num: null,
              value_text: null,
            },
            {
              id: "m2",
              kind: "context_switch",
              t_start_ms: 5000,
              value_num: null,
              value_text: null,
            },
            {
              id: "m3",
              kind: "utterance",
              t_start_ms: 2000,
              value_num: null,
              value_text: "Let me show you this feature",
            },
          ],
        })
      }
      // Status poll
      return jsonResponse({ analysis: makeAnalysis() })
    })

    render(
      <AnalysisStatusPanel
        videoId="vid-bbbb-0000-0000-000000000001"
        videoStatus="uploaded"
        initialAnalysis={makeAnalysis()}
        videoDurationMs={300_000}
      />
    )

    // Advance timer to trigger the poll
    await act(async () => {
      vi.advanceTimersByTime(2500)
      // flush promises
      await Promise.resolve()
      await Promise.resolve()
    })

    const container = screen.getByTestId("found-so-far")
    expect(container).toBeInTheDocument()
    expect(container.textContent).toContain("2")
    expect(container.textContent).toContain("context switch")
    expect(container.textContent).toContain("1")
    expect(container.textContent).toContain("utterance")
    expect(container.textContent).toContain("Let me show you this feature")
  })

  it("shows nothing when no measures have arrived yet", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/measures")) {
        return jsonResponse({ measures: [] })
      }
      return jsonResponse({ analysis: makeAnalysis() })
    })

    render(
      <AnalysisStatusPanel
        videoId="vid-bbbb-0000-0000-000000000001"
        videoStatus="uploaded"
        initialAnalysis={makeAnalysis()}
        videoDurationMs={300_000}
      />
    )

    await act(async () => {
      vi.advanceTimersByTime(2500)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByTestId("found-so-far")).not.toBeInTheDocument()
  })

  it("shows sentiment counts when present", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/measures")) {
        return jsonResponse({
          measures: [
            {
              id: "s1",
              kind: "sentiment",
              t_start_ms: 1000,
              value_num: 0.8,
              value_text: null,
            },
            {
              id: "s2",
              kind: "sentiment",
              t_start_ms: 3000,
              value_num: -0.6,
              value_text: null,
            },
            {
              id: "s3",
              kind: "sentiment",
              t_start_ms: 5000,
              value_num: 0.5,
              value_text: null,
            },
          ],
        })
      }
      return jsonResponse({ analysis: makeAnalysis() })
    })

    render(
      <AnalysisStatusPanel
        videoId="vid-bbbb-0000-0000-000000000001"
        videoStatus="uploaded"
        initialAnalysis={makeAnalysis()}
        videoDurationMs={300_000}
      />
    )

    await act(async () => {
      vi.advanceTimersByTime(2500)
      await Promise.resolve()
      await Promise.resolve()
    })

    const container = screen.getByTestId("found-so-far")
    expect(container.textContent).toContain("2")
    expect(container.textContent).toContain("positive")
    expect(container.textContent).toContain("1")
    expect(container.textContent).toContain("negative")
  })

  it("shows report preview skeleton on terminal state", async () => {
    render(
      <AnalysisStatusPanel
        videoId="vid-bbbb-0000-0000-000000000001"
        videoStatus="uploaded"
        initialAnalysis={makeAnalysis({ status: "succeeded", progress_pct: 100 })}
        videoDurationMs={300_000}
      />
    )

    expect(screen.getByTestId("report-preview-skeleton")).toBeInTheDocument()
    expect(screen.getByText(/View report/)).toBeInTheDocument()
  })

  it("shows ETA string when video duration is provided", async () => {
    // 5 minute video → ~2min left at 45% progress
    render(
      <AnalysisStatusPanel
        videoId="vid-bbbb-0000-0000-000000000001"
        videoStatus="uploaded"
        initialAnalysis={makeAnalysis({ progress_pct: 45 })}
        videoDurationMs={300_000}
      />
    )

    // ETA should appear in the panel
    const etaEl = document.querySelector(".text-right.text-xs")
    expect(etaEl?.textContent).toMatch(/min left|finishing up/)
  })
})
