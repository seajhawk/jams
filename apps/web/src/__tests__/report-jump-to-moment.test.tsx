import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ReportPayload } from "@/lib/report-contract"
import { activeMomentId, buildMoments, playbackStartMs } from "@/lib/report-moments"

const player = vi.hoisted(() => ({
  instance: { currentTime: 0, paused: true, play: vi.fn() },
}))

// The real player is a media element; the shell only needs a ref to something with play/currentTime.
vi.mock("@/components/report/VideoPlayer", () => ({
  VideoPlayer: ({ playerRef }: { playerRef: { current: unknown } }) => {
    playerRef.current = player.instance
    return <div data-testid="video-player" />
  },
}))
vi.mock("@/components/report/ReportHeader", () => ({ ReportHeader: () => null }))
vi.mock("@/components/report/ScoreTab", () => ({ ScoreTab: () => null }))
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }))
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }))
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import { ReportShell } from "@/components/report/ReportShell"

const measureBase = { confidence: 0.9, source: "video_analysis", unit: null, value_num: null, value_text: null }

const utterance = (id: string, t0: number, t1: number, text: string) => ({
  ...measureBase,
  id,
  kind: "utterance",
  category: "speech",
  t_start_ms: t0,
  t_end_ms: t1,
  value_text: text,
  payload: { text, words: [] },
})

const sentiment = (id: string, t0: number, t1: number, value: number, utteranceId: string) => ({
  ...measureBase,
  id,
  kind: "sentiment",
  category: "sentiment",
  t_start_ms: t0,
  t_end_ms: t1,
  value_num: value,
  unit: "score",
  payload: { utterance_measure_id: utteranceId },
})

const payload = {
  video: { id: "v1", title: "Checkout", duration_ms: 60_000, playback_url: "https://blob.test/v.mp4" },
  segments: [
    { id: "seg1", name: "Cart", t_start_ms: 0, t_end_ms: 30_000, parent_segment_id: null },
    { id: "seg1a", name: "Coupon", t_start_ms: 5_000, t_end_ms: 9_000, parent_segment_id: "seg1" },
    { id: "seg2", name: "Payment", t_start_ms: 30_000, t_end_ms: 60_000, parent_segment_id: null },
  ],
  measures: [
    utterance("u1", 10_000, 13_000, "This is so confusing, where is the button?"),
    utterance("u2", 20_000, 23_000, "Okay that works."),
    utterance("u3", 40_000, 44_000, "Oh nice, that was easy."),
    sentiment("s1", 10_000, 13_000, -0.82, "u1"),
    sentiment("s2", 20_000, 23_000, -0.05, "u2"),
    sentiment("s3", 40_000, 44_000, 0.9, "u3"),
    sentiment("s4", 50_000, 52_000, -0.35, "missing-utterance"),
    {
      ...measureBase,
      id: "cs1",
      kind: "context_switch",
      category: "cognitive",
      t_start_ms: 30_000,
      t_end_ms: null,
      payload: { from: "Cart", to: "Payment" },
    },
  ],
  score: { profile: { id: "p1", weights: {}, normalization: {} } },
} as unknown as ReportPayload

describe("buildMoments", () => {
  it("keeps only standout sentiment, switches and top-level segments, in time order", () => {
    const moments = buildMoments(payload)

    expect(moments.map((m) => [m.tMs, m.kind])).toEqual([
      [0, "segment"],
      [10_000, "negative"],
      [30_000, "segment"],
      [30_000, "switch"],
      [40_000, "positive"],
      [50_000, "negative"],
    ])
  })

  it("quotes what was said for a sentiment moment, and calls strong negatives frustration", () => {
    const frustrated = buildMoments(payload).find((m) => m.tMs === 10_000)!

    expect(frustrated.title).toBe("Frustrated")
    expect(frustrated.detail).toBe("This is so confusing, where is the button?")
    expect(frustrated.score).toBe(-0.82)
  })

  it("labels milder negatives as negative and tolerates a sentiment with no matching utterance", () => {
    const mild = buildMoments(payload).find((m) => m.tMs === 50_000)!

    expect(mild.title).toBe("Negative")
    expect(mild.detail).toBeNull()
  })

  it("describes a context switch by where it came from and went", () => {
    expect(buildMoments(payload).find((m) => m.kind === "switch")!.title).toBe("Switched from Cart to Payment")
  })

  it("finds the moment the playhead has reached", () => {
    const moments = buildMoments(payload)

    expect(activeMomentId(moments, -1)).toBeNull()
    expect(moments.find((m) => m.id === activeMomentId(moments, 12_000))!.tMs).toBe(10_000)
  })

  it("starts playback slightly before the moment, but never before the start", () => {
    expect(playbackStartMs(10_000)).toBe(8_500)
    expect(playbackStartMs(400)).toBe(0)
  })
})

describe("jumping from the analysis to the video", () => {
  beforeEach(() => {
    player.instance.currentTime = 0
    // jsdom has no layout, so no scrollIntoView; the transcript calls it to follow the playhead.
    Element.prototype.scrollIntoView = vi.fn()
    player.instance.play = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  function renderShell() {
    render(<ReportShell payload={payload} />)
  }

  it("plays a highlight from just before it, so the reviewer hears the moment", async () => {
    renderShell()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play Frustrated at 00:10" }))
    })

    expect(player.instance.currentTime).toBe(8.5)
    expect(player.instance.play).toHaveBeenCalledTimes(1)
  })

  it("plays a transcript line from its start", async () => {
    renderShell()

    await act(async () => {
      fireEvent.click(
        screen.getAllByTestId("transcript-row").find((r) => r.getAttribute("data-start-ms") === "40000")!
      )
    })

    expect(player.instance.currentTime).toBe(40)
    expect(player.instance.play).toHaveBeenCalledTimes(1)
  })

  it("plays a sentiment reading clicked on the timeline", async () => {
    renderShell()

    const readings = screen.getAllByTestId("timeline-sentiment")
    await act(async () => {
      fireEvent.click(readings[0])
    })

    expect(player.instance.currentTime).toBe(8.5)
    expect(player.instance.play).toHaveBeenCalledTimes(1)
  })

  it("scrubbing the bare timeline seeks without starting playback", async () => {
    renderShell()

    await act(async () => {
      fireEvent.click(screen.getByTestId("report-timeline"), { clientX: 0 })
    })

    expect(player.instance.play).not.toHaveBeenCalled()
  })

  it("still moves the playhead when the browser refuses to play", async () => {
    player.instance.play = vi.fn().mockRejectedValue(new Error("NotAllowedError"))
    renderShell()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play Frustrated at 00:10" }))
    })

    expect(player.instance.currentTime).toBe(8.5)
  })

  it("filters highlights down to one kind", async () => {
    renderShell()

    fireEvent.click(screen.getByRole("button", { name: /^Negative \(2\)$/ }))

    expect(screen.getAllByTestId("highlight-row")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: /Play Cart/ })).toBeNull()
  })
})
