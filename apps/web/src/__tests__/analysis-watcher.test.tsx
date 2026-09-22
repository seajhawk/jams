import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { AnalysisWatcher } from "@/components/app/AnalysisWatcher"
import { analysisStarted } from "@/lib/analysis-watch"

type Settled = { status: string; error_code: string | null }

const world = {
  active: [] as { id: string; video_title: string | null; status: string }[],
  settled: {} as Record<string, Settled>,
  listFails: false,
  detailFails: false,
  listCalls: 0,
}

const notified: { title: string; body: string | undefined }[] = []

class FakeNotification {
  static permission: NotificationPermission = "granted"
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission)
  constructor(title: string, options?: NotificationOptions) {
    notified.push({ title, body: options?.body })
  }
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

/** Let the poll's promise chain resolve, then advance to the next scheduled poll. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const RUN = { id: "run-1", video_title: "Checkout walkthrough", status: "running" }

describe("AnalysisWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    world.active = []
    world.settled = {}
    world.listFails = false
    world.detailFails = false
    world.listCalls = 0
    notified.length = 0
    mocks.push.mockClear()
    mocks.refresh.mockClear()
    mocks.toast.success.mockClear()
    mocks.toast.error.mockClear()
    FakeNotification.permission = "granted"
    vi.stubGlobal("Notification", FakeNotification)
    Object.defineProperty(document, "hidden", { value: false, configurable: true })
    document.title = "Library - JAMS"

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.startsWith("/api/analyses?active=")) {
          world.listCalls += 1
          if (world.listFails) throw new Error("offline")
          return { ok: true, json: async () => ({ analyses: world.active }) }
        }
        const id = input.replace("/api/analyses/", "")
        if (world.detailFails) return { ok: false, json: async () => ({}) }
        return { ok: true, json: async () => ({ analysis: { id, ...world.settled[id] } }) }
      })
    )
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function mount() {
    render(<AnalysisWatcher />)
    await settle()
  }

  it("announces a run that finishes, with a way to reach the report", async () => {
    world.active = [RUN]
    await mount()

    world.active = []
    world.settled["run-1"] = { status: "succeeded", error_code: null }
    await settle(2500)

    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.toast.success.mock.calls[0]
    expect(message).toContain("Checkout walkthrough")
    expect(options.action.label).toBe("View report")

    options.action.onClick()
    expect(mocks.push).toHaveBeenCalledWith("/reports/run-1")
    // Whatever page the user is on was rendered before this finished.
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it("announces each run only once, however long it keeps polling", async () => {
    world.active = [RUN]
    await mount()

    world.active = []
    world.settled["run-1"] = { status: "succeeded", error_code: null }
    await settle(2500)
    await settle(30_000)
    await settle(30_000)

    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
  })

  it("says nothing about work that was already finished when the app opened", async () => {
    world.active = []
    await mount()
    await settle(30_000)

    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it("explains a failure in plain language instead of celebrating it", async () => {
    world.active = [RUN]
    await mount()

    world.active = []
    world.settled["run-1"] = { status: "failed", error_code: "corrupt_file" }
    await settle(2500)

    expect(mocks.toast.success).not.toHaveBeenCalled()
    const [message, options] = mocks.toast.error.mock.calls[0]
    expect(message).toContain("Checkout walkthrough")
    expect(options.description).toMatch(/could not read this video file/i)
  })

  it("keeps quiet while the tab is in front: no desktop notification, no title badge", async () => {
    world.active = [RUN]
    await mount()

    world.active = []
    world.settled["run-1"] = { status: "succeeded", error_code: null }
    await settle(2500)

    expect(notified).toHaveLength(0)
    expect(document.title).toBe("Library - JAMS")
  })

  it("badges the tab and raises a desktop notification when the user is elsewhere", async () => {
    world.active = [RUN]
    await mount()
    setHidden(true)

    world.active = []
    world.settled["run-1"] = { status: "succeeded", error_code: null }
    await settle(2500)

    expect(document.title).toBe("(1) Analysis ready - Library - JAMS")
    expect(notified).toEqual([
      { title: "Analysis complete", body: "Checkout walkthrough is ready to review." },
    ])

    setHidden(false)
    await settle()
    expect(document.title).toBe("Library - JAMS")
  })

  it("does not notify when the user never granted permission", async () => {
    FakeNotification.permission = "denied"
    world.active = [RUN]
    await mount()
    setHidden(true)

    world.active = []
    world.settled["run-1"] = { status: "succeeded", error_code: null }
    await settle(2500)

    expect(notified).toHaveLength(0)
    // The in-app signals still work.
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    expect(document.title).toBe("(1) Analysis ready - Library - JAMS")
  })

  it("treats a failed poll as no news, not as a finished run", async () => {
    world.active = [RUN]
    await mount()

    world.listFails = true
    await settle(2500)
    await settle(2500)

    expect(mocks.toast.success).not.toHaveBeenCalled()

    // When the network comes back and the run really has finished, it is announced then.
    world.listFails = false
    world.active = []
    world.settled["run-1"] = { status: "succeeded", error_code: null }
    await settle(2500)

    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
  })

  it("retries an announcement whose status lookup failed", async () => {
    world.active = [RUN]
    await mount()

    world.detailFails = true
    world.active = []
    world.settled["run-1"] = { status: "succeeded", error_code: null }
    await settle(2500)
    expect(mocks.toast.success).not.toHaveBeenCalled()

    // The run has already left the active list, so the watcher has to keep holding it itself
    // until the lookup works; otherwise the completion is lost for good.
    world.detailFails = false
    await settle(2500)

    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
  })

  it("polls slowly when there is nothing to watch, and quickly once there is", async () => {
    await mount()
    const idleStart = world.listCalls

    await settle(2500)
    expect(world.listCalls).toBe(idleStart)

    await settle(30_000)
    expect(world.listCalls).toBe(idleStart + 1)

    // A run starting anywhere in the app wakes the watcher immediately.
    world.active = [RUN]
    await act(async () => {
      analysisStarted()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(world.listCalls).toBe(idleStart + 2)

    await settle(2500)
    expect(world.listCalls).toBe(idleStart + 3)
  })
})
