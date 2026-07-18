import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ReanalyzeDialog } from "@/components/upload/ReanalyzeDialog"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  )
}

function renderDialog(onCreated = vi.fn()) {
  render(
    <ReanalyzeDialog
      videoId="e9c82777-2cd1-4691-9cf9-2e9f5c6f2a11"
      currentConfig={{ sentiment: { fallback: "none" } }}
      currentConfigSource={null}
      onCreated={onCreated}
    />
  )
  fireEvent.click(screen.getByText("Re-analyze"))
  fireEvent.click(screen.getByText("Advanced"))
}

describe("ReanalyzeDialog", () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it("round-trips edited YAML as canonical config and source text", async () => {
    const onCreated = vi.fn()
    mockFetch.mockResolvedValue(
      jsonResponse({
        analysis: {
          id: "8c980f72-91f2-4778-bf2c-57c6f72f9b40",
          config: {},
          config_source: "sentiment:\n  fallback: vader\n",
          pipeline_version: "current",
          status: "queued",
          superseded_by: null,
          timestamps: {
            created_at: "2026-07-17T12:00:00.000Z",
            completed_at: null,
          },
        },
      })
    )

    renderDialog(onCreated)
    const editor = screen.getByLabelText("Analysis config YAML")
    fireEvent.change(editor, {
      target: { value: "sentiment:\n  fallback: vader\n" },
    })
    fireEvent.click(screen.getByText("Start"))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body)) as {
      config: {
        context_switch: { detector_impl: string }
        sentiment: { fallback: string }
      }
      config_source: string
    }
    expect(body.config.sentiment.fallback).toBe("vader")
    expect(body.config.context_switch.detector_impl).toBe("adaptive")
    expect(body.config_source).toBe("sentiment:\n  fallback: vader\n")
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it("shows path-aware validation errors without submitting", async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText("Analysis config YAML"), {
      target: { value: "context_switch:\n  enabled: false\n" },
    })
    fireEvent.click(screen.getByText("Start"))

    expect(await screen.findByText(/context_switch\.enabled/)).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
