import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@testing-library/jest-dom/vitest"
import { LibraryContent } from "@/components/upload/LibraryContent"

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams("new=video-1"),
}))

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

vi.mock("@/components/upload/UploadDialog", () => ({
  UploadDialog: () => <button type="button">Upload journey</button>,
}))

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

const uploadedVideo = {
  id: "video-1",
  task_id: null,
  task_name: null,
  title: "Pipeline fixture",
  blob_path: "org/video-1/original.mp4",
  poster_blob_path: null,
  size_bytes: 1234,
  content_type: "video/mp4",
  duration_ms: 12_000,
  width: 640,
  height: 360,
  fps: 30,
  has_audio: false,
  subject_label: null,
  variant_label: null,
  status: "uploaded" as const,
  uploaded_by: "user-1",
  created_at: "2026-09-11T00:00:00.000Z",
  latest_run: null,
}

describe("LibraryContent upload highlight", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    routerMocks.push.mockReset()
    routerMocks.replace.mockReset()
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/videos")) {
        return Promise.resolve(new Response(JSON.stringify({ videos: [uploadedVideo] }), { status: 200 }))
      }
      if (url === "/api/tasks") {
        return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }))
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps the detail navigation after the three second highlight expiry", async () => {
    render(<LibraryContent />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const openButton = screen.getByRole("button", { name: "Open Pipeline fixture" })
    await act(async () => {
      fireEvent.click(openButton)
    })
    expect(routerMocks.push).toHaveBeenCalledTimes(1)
    expect(routerMocks.push).toHaveBeenCalledWith("/library/video-1")

    await act(async () => {
      vi.advanceTimersByTime(3_000)
      await Promise.resolve()
    })

    expect(routerMocks.push).toHaveBeenCalledTimes(1)
    expect(routerMocks.replace).not.toHaveBeenCalled()
  })
})
