import { afterEach, describe, expect, it, vi } from "vitest"

import { extractVideoMetadata } from "@/components/upload/useVideoMetadata"

// jsdom does not decode real video, so we mock createElement to return
// controlled video / canvas objects whose event listeners we fire manually.

describe("extractVideoMetadata", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("resolves with duration, dimensions, and a JPEG poster blob", async () => {
    const originalCreateElement = document.createElement.bind(document)

    // Shared listener registry
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((cb: (blob: Blob | null) => void) => {
        cb(new Blob(["fake-jpeg"], { type: "image/jpeg" }))
      }),
    }

    const mockVideo = {
      preload: "",
      muted: false,
      crossOrigin: "",
      duration: 65.5,
      videoWidth: 1280,
      videoHeight: 720,
      pause: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(
        (event: string, handler: (...args: unknown[]) => void) => {
          if (!listeners[event]) listeners[event] = []
          listeners[event].push(handler)
        }
      ),
      removeEventListener: vi.fn(),
    }

    // When `src` is set → fire loadedmetadata; when `currentTime` is set → fire seeked
    let _src = ""
    Object.defineProperty(mockVideo, "src", {
      configurable: true,
      get: () => _src,
      set: (v: string) => {
        _src = v
        setTimeout(() => listeners["loadedmetadata"]?.forEach((h) => h()), 0)
      },
    })

    let _ct = 0
    Object.defineProperty(mockVideo, "currentTime", {
      configurable: true,
      get: () => _ct,
      set: (v: number) => {
        _ct = v
        setTimeout(() => listeners["seeked"]?.forEach((h) => h()), 0)
      },
    })

    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock")
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined)

    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        if (tagName === "video")
          return mockVideo as unknown as HTMLVideoElement
        if (tagName === "canvas")
          return mockCanvas as unknown as HTMLCanvasElement
        return originalCreateElement(tagName)
      }
    )

    const fakeFile = new File(["video-data"], "demo.mp4", {
      type: "video/mp4",
    })

    const meta = await extractVideoMetadata(fakeFile)

    expect(meta.durationMs).toBe(65500) // 65.5 * 1000, rounded
    expect(meta.width).toBe(1280)
    expect(meta.height).toBe(720)
    expect(meta.posterBlob).toBeInstanceOf(Blob)
    expect(meta.posterBlob.type).toBe("image/jpeg")
    // Canvas was drawn at capped dimensions (1280 ≤ 1920, no downscale)
    expect(mockCanvas.getContext).toHaveBeenCalledWith("2d")
    expect(mockCanvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      "image/jpeg",
      0.8
    )
  })

  it("rejects when the video element fires an error event", async () => {
    const originalCreateElement = document.createElement.bind(document)

    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}

    const mockVideo = {
      preload: "",
      muted: false,
      crossOrigin: "",
      duration: 0,
      videoWidth: 0,
      videoHeight: 0,
      pause: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(
        (event: string, handler: (...args: unknown[]) => void) => {
          if (!listeners[event]) listeners[event] = []
          listeners[event].push(handler)
        }
      ),
      removeEventListener: vi.fn(),
    }

    let _src = ""
    Object.defineProperty(mockVideo, "src", {
      configurable: true,
      get: () => _src,
      set: (v: string) => {
        _src = v
        // Simulate a load error
        setTimeout(() => listeners["error"]?.forEach((h) => h()), 0)
      },
    })

    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock")
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined)

    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string) => {
        if (tagName === "video")
          return mockVideo as unknown as HTMLVideoElement
        return originalCreateElement(tagName)
      }
    )

    const fakeFile = new File(["bad"], "corrupt.mp4", { type: "video/mp4" })

    await expect(extractVideoMetadata(fakeFile)).rejects.toThrow(
      "Failed to load video"
    )
  })
})
