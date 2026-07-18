import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const W = 640
const H = 480
const FPS = 30
const FLASH_1_MS = 1000
const FLASH_2_MS = 1600
const FLASH_DURATION_MS = 120
const SCENARIOS = ["cv_scroll_page", "cv_button_grid", "cv_hover_negative"]

function parseArgs() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 1) {
    if (!process.argv[index].startsWith("--")) continue
    const key = process.argv[index].slice(2)
    const value = process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[++index]
    args.set(key, value ?? "true")
  }
  return {
    outputDir: args.get("output-dir") ?? path.resolve("..", "..", "tests", "fixtures", "generated"),
    ffmpeg: args.get("ffmpeg") ?? process.env.FFMPEG ?? "ffmpeg",
  }
}

function htmlForScenario(name) {
  const commonStyle = `
    html, body { margin: 0; width: ${W}px; min-height: ${H}px; font-family: Arial, sans-serif; }
    body { background: #111827; color: #e5e7eb; overflow: hidden; }
    #syncFlash { position: fixed; inset: 0; background: #fff; opacity: 0; z-index: 99999; pointer-events: none; }
    .topbar { height: 52px; display: flex; align-items: center; padding: 0 18px; background: #0f172a; border-bottom: 1px solid #334155; }
  `
  if (name === "cv_scroll_page") {
    const rows = Array.from({ length: 90 }, (_, i) => `<p>Line ${String(i + 1).padStart(2, "0")} - fixed-height journey instruction text.</p>`).join("")
    return `
      <style>${commonStyle}
        body { overflow: auto; }
        main { padding: 18px 30px; }
        p { height: 24px; line-height: 24px; margin: 0; border-bottom: 1px solid #263244; }
      </style>
      <div id="syncFlash"></div><div class="topbar">Scroll fixture</div><main>${rows}</main>
    `
  }
  if (name === "cv_button_grid") {
    const buttons = Array.from({ length: 12 }, (_, i) => `<button data-fixture-button="${i}">Action ${i + 1}</button>`).join("")
    return `
      <style>${commonStyle}
        main { padding: 22px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
        button { height: 74px; border: 2px solid #64748b; background: #1f2937; color: white; font-size: 15px; }
        button:active { background: #f59e0b; color: #111827; transform: translateY(3px); }
        #status { position: fixed; left: 24px; right: 24px; bottom: 22px; height: 44px; line-height: 44px; background: #164e63; text-align: center; }
      </style>
      <div id="syncFlash"></div><div class="topbar">Button grid fixture</div><main>${buttons}</main><div id="status">idle</div>
      <script>
        document.addEventListener("click", (event) => {
          const button = event.target.closest("button")
          if (!button) return
          document.querySelector("#status").textContent = "pressed " + button.dataset.fixtureButton
        })
      </script>
    `
  }
  return `
    <style>${commonStyle}
      main { height: 428px; display: grid; place-items: center; }
      #hoverTarget { width: 180px; height: 180px; background: #2563eb; transition: transform 180ms linear, background 180ms linear; }
      #hoverTarget:hover { transform: translateX(120px); background: #10b981; }
    </style>
    <div id="syncFlash"></div><div class="topbar">Hover negative fixture</div><main><div id="hoverTarget"></div></main>
  `
}

async function installCapture(context, events) {
  await context.exposeBinding("jamsRecordEvent", (_source, event) => {
    events.push(event)
  })
  await context.addInitScript(({ flash1Ms, flash2Ms, flashDurationMs }) => {
    window.jamsInstallCapture = () => {
      if (window.__jamsCaptureInstalled) return
      window.__jamsCaptureInstalled = true
      const capture = (event) => {
        const target = event.target instanceof Element ? event.target : null
        window.jamsRecordEvent({
          kind: event.type,
          t_ms: performance.now(),
          x: "clientX" in event ? Math.round(event.clientX) : null,
          y: "clientY" in event ? Math.round(event.clientY) : null,
          delta_x: "deltaX" in event ? Math.round(event.deltaX) : null,
          delta_y: "deltaY" in event ? Math.round(event.deltaY) : null,
          key: "key" in event ? event.key : null,
          target: target?.getAttribute("data-fixture-button") ?? target?.id ?? target?.tagName ?? null,
        })
      }
      for (const type of ["click", "mousedown", "mouseup", "keydown", "wheel", "mousemove"]) {
        window.addEventListener(type, capture, { passive: true, capture: true })
      }
    }
    const capture = (event) => {
      const target = event.target instanceof Element ? event.target : null
      window.jamsRecordEvent({
        kind: event.type,
        t_ms: performance.now(),
        x: "clientX" in event ? Math.round(event.clientX) : null,
        y: "clientY" in event ? Math.round(event.clientY) : null,
        delta_x: "deltaX" in event ? Math.round(event.deltaX) : null,
        delta_y: "deltaY" in event ? Math.round(event.deltaY) : null,
        key: "key" in event ? event.key : null,
        target: target?.getAttribute("data-fixture-button") ?? target?.id ?? target?.tagName ?? null,
      })
    }
    for (const type of ["click", "mousedown", "mouseup", "keydown", "wheel", "mousemove"]) {
      window.addEventListener(type, capture, { passive: true, capture: true })
    }
    window.jamsSyncFlash = async () => {
      const flash = document.querySelector("#syncFlash")
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const emit = (index, phase) => window.jamsRecordEvent({
        kind: "sync_flash",
        phase,
        index,
        t_ms: performance.now(),
      })
      await wait(flash1Ms)
      emit(1, "start")
      flash.style.opacity = "1"
      await wait(flashDurationMs)
      flash.style.opacity = "0"
      emit(1, "end")
      await wait(flash2Ms - flash1Ms - flashDurationMs)
      emit(2, "start")
      flash.style.opacity = "1"
      await wait(flashDurationMs)
      flash.style.opacity = "0"
      emit(2, "end")
    }
  }, {
    flash1Ms: FLASH_1_MS,
    flash2Ms: FLASH_2_MS,
    flashDurationMs: FLASH_DURATION_MS,
  })
}

async function driveScenario(page, name) {
  await page.evaluate(() => window.jamsSyncFlash())
  if (name === "cv_scroll_page") {
    for (let i = 0; i < 9; i += 1) {
      await page.mouse.wheel(0, 180)
      await page.waitForTimeout(180)
    }
    return
  }
  if (name === "cv_button_grid") {
    for (const index of [0, 5, 11, 3, 8]) {
      const button = page.locator(`[data-fixture-button="${index}"]`)
      await button.click()
      await page.waitForTimeout(220)
    }
    await page.keyboard.press("Tab")
    await page.keyboard.press("Enter")
    return
  }
  await page.locator("#hoverTarget").hover()
  await page.waitForTimeout(900)
  await page.mouse.move(30, 70)
  await page.waitForTimeout(500)
}

function normalizeVideo(ffmpeg, webmPath, mp4Path) {
  execFileSync(ffmpeg, [
    "-y",
    "-i", webmPath,
    "-vf", `fps=${FPS}`,
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-an",
    mp4Path,
  ], { stdio: "pipe" })
}

async function recordScenario(browser, outputDir, ffmpeg, scenario) {
  const tempDir = await mkdtemp(path.join(tmpdir(), `jams-cv-${scenario}-`))
  const events = []
  try {
  const context = await browser.newContext({
      viewport: { width: W, height: H },
      recordVideo: { dir: tempDir, size: { width: W, height: H } },
    })
    await installCapture(context, events)
    const page = await context.newPage()
    await page.setContent(htmlForScenario(scenario), { waitUntil: "load" })
    await page.evaluate(() => window.jamsInstallCapture())
    await driveScenario(page, scenario)
    await page.waitForTimeout(700)
    const video = page.video()
    await page.close()
    await context.close()
    const webmPath = await video.path()
    const mp4Name = `${scenario}.mp4`
    const jsonlName = `${scenario}.events.jsonl`
    const gtName = `${scenario}.gt.json`
    normalizeVideo(ffmpeg, webmPath, path.join(outputDir, mp4Name))
    await writeFile(
      path.join(outputDir, jsonlName),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    )
    const gt = {
      id: scenario,
      file: mp4Name,
      kind: "video",
      duration_ms: null,
      events_jsonl: jsonlName,
      fps: FPS,
      has_audio: false,
      provider_pending: scenario === "cv_hover_negative" ? "F10-b/c negative" : "F10-b/c",
      scroll_events: scenario === "cv_scroll_page"
        ? [{ direction: "down", percent_viewport: 9.0 }]
        : [],
      sync_marker: {
        flash_count: 2,
        flash_duration_ms: FLASH_DURATION_MS,
        flash_starts_ms: [FLASH_1_MS, FLASH_2_MS],
      },
      tts_pending: false,
    }
    await writeFile(path.join(outputDir, gtName), JSON.stringify(gt, null, 2) + "\n")
    return gt
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  const { outputDir, ffmpeg } = parseArgs()
  await mkdir(outputDir, { recursive: true })
  const browser = await chromium.launch()
  try {
    const generated = []
    for (const scenario of SCENARIOS) {
      generated.push(await recordScenario(browser, outputDir, ffmpeg, scenario))
    }
    const registryPath = path.join(outputDir, "cv_registry.json")
    await writeFile(registryPath, JSON.stringify({ generated }, null, 2) + "\n")
    const registry = JSON.parse(await readFile(registryPath, "utf8"))
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n")
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
