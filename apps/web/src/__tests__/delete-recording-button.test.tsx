import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}))
vi.mock("sonner", () => ({ toast: { success: mocks.success } }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : <>{children}</>,
  DialogTrigger: ({ render }: { render: React.ReactElement }) => render,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

import { DeleteRecordingButton } from "@/components/upload/DeleteRecordingButton"

describe("DeleteRecordingButton", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.replace.mockReset()
    mocks.refresh.mockReset()
    mocks.success.mockReset()
  })

  it("cancels without calling the delete API", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
    render(<DeleteRecordingButton videoId="video-1" title="Checkout journey" />)

    fireEvent.click(screen.getAllByRole("button", { name: "Delete recording" })[0])
    expect(screen.getByText("Checkout journey")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("navigates and announces queued cleanup after success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }))
    render(<DeleteRecordingButton videoId="video-1" title="Checkout journey" />)

    fireEvent.click(screen.getAllByRole("button", { name: "Delete recording" })[0])
    fireEvent.click(screen.getAllByRole("button", { name: "Delete recording" })[1])

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/library"))
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.success).toHaveBeenCalledWith("Recording removed. Storage cleanup is queued.")
  })

  it("shows a retryable error and retries after failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Cleanup unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
    render(<DeleteRecordingButton videoId="video-1" title="Checkout journey" />)

    fireEvent.click(screen.getAllByRole("button", { name: "Delete recording" })[0])
    fireEvent.click(screen.getAllByRole("button", { name: "Delete recording" })[1])
    expect((await screen.findByRole("alert")).textContent).toContain("Cleanup unavailable")
    fireEvent.click(screen.getAllByRole("button", { name: "Delete recording" })[1])

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(mocks.replace).toHaveBeenCalledWith("/library")
  })
})
