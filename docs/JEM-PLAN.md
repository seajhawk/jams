<!-- JEM project plan. Drafted by kimi-k3 via aider ($0.34, 22k tokens, 2026-07-20). Reviewed + amended by Claude (Fable) — see review at bottom; apply Corrections 1 & 2 before/at build. -->

# JEM — Journey Effort Meter

## Implementation-Ready Project Plan



| | |

|---|---|

| Status | Ready to build |

| Audience | AI coding session / engineer implementing JEM |

| Rule | Build from THIS document. Do not reference any prior JEM code (see 
§3). |

| Convention | Values marked **[TUNE]** are informed guesses to be dialed in 
during build/test. Values marked **[VERIFY]** depend on tool versions and must 
be confirmed at implementation time. |



---



## 1. Purpose



**JEM is the ground-truth data generator for JAMS.** JAMS is a separate SaaS 
that uses AI to detect effort and sentiment measures from screen-recording 
video: clicks, keypresses, scrolls, context switches, time-on-task, plus 
AI-only concepts/choices/sentiment. JAMS's physical and context measures are 
currently **unvalidated** and ship at Effort-Score weight 0.



JEM closes that gap. It records a screen session **and** deterministically logs
the true low-level activity (via Windows APIs, not inference), producing a 
synchronized pair:



- `*.mp4` — exactly what the user saw/did (the JAMS input), and

- `*.csv` — exactly what actually happened (the truth).



Feeding the video through JAMS and diffing JAMS's detected measures against 
JEM's recorded truth yields **precision / recall / F1 / count accuracy per 
measure kind**. Those metrics are used to tune JAMS's detection thresholds, 
tune its LLM prompts, or train a model — and ultimately to justify raising the 
weight-0 measures to real weights. JEM is the validation/calibration companion,
not a scorer.



**Non-goals:** no AI, no Effort Score, no cloud upload, no multi-user, no 
multi-monitor capture, no capture of concepts/choices/sentiment (those are 
AI-only and cannot be ground-truthed by JEM).



---



## 2. Stack



**C# / .NET 8, WPF.**



Rationale:



- First-class P/Invoke access to global low-level hooks: `SetWindowsHookEx` 
with `WH_MOUSE_LL` / `WH_KEYBOARD_LL`.

- Foreground/window events via `SetWinEventHook` (`EVENT_SYSTEM_FOREGROUND`, 
`EVENT_OBJECT_NAMECHANGE`).

- UI Automation via `System.Windows.Automation` (UIAutomationClient) for the 
Edge URL and terminal best-effort features.

- Easy subprocess management of `ffmpeg` (stdin control for clean stop — see 
§5).

- WPF `DataGrid` makes the live context-shift table trivial.

- Single-file self-contained publish (`dotnet publish -r win-x64 
-p:PublishSingleFile=true --self-contained`) for friction-free distribution.



**Fallback alternative (documented, not chosen):** Python (`pywin32` + 
`uiautomation` + `pynput` + ffmpeg subprocess). Honest tradeoff: native LL 
hooks, UIA interop, and packaging (single-exe distribution, code signing) are 
all rougher in Python; hook timing and process lifecycles are more fragile. 
Only revisit if .NET development velocity proves unworkable.



---



## 3. Legal / Clean-Room Discipline (mandatory)



The previous JEM was .NET and its **source code belongs to the author's 
employer**. The concept, the requirements, and the Windows platform APIs are 
not owned by anyone. Therefore:



- Build **only** from this specification.

- **Never** open, reference, copy, port, or "consult" the old source. Fresh 
repo, fresh code, fresh identifiers.

- Architecture decisions in this document are derived from the requirements and
public Windows API documentation, not from the prior implementation.



*Practical note: the author should confirm this arrangement fits their own 
employment agreement. This is not legal advice.*



---



## 4. Architecture Overview



Proposed layout (names are a starting point, not sacred):



~~~

jem/

  JEM.sln

  src/

    Jem.Core/        # SessionClock, pause/active-time math, CSV writer, 
schema,

                     # key categorizer, scroll aggregator, title/URL parsers.

                     # No UI, no P/Invoke. Fully unit-testable.

    Jem.Platform/    # P/Invoke wrappers: LL hooks, WinEvent hooks, 
monitor/window

                     # APIs, UIA resolvers. Thin; pushes events into Jem.Core.

    Jem.Recording/   # IScreenRecorder + FFmpegRecorder (ddagrab / gdigrab),

                     # segment manager, concat finalizer.

    Jem.App/         # WPF: main window, live DataGrid, controls, sync-flash 
window.

  tests/

    Jem.Core.Tests/

    Jem.Platform.Tests/

  tools/

    Jem.TestInjector/  # SendInput-based integration test driver (§14).

  vendor/ffmpeg/       # or configured external path (§16 open decision)

  jem.config.json

  PROJECT_PLAN.md

~~~



**Threading model (decided):**



- One dedicated STA thread running its own `Dispatcher` message pump owns 
**both** the LL hooks and the WinEvent hooks. LL hook callbacks execute on the 
installing thread's message loop, so that thread must pump; keeping it off the 
UI thread prevents hook latency from stalling the UI and vice versa.

- Hook callbacks do **zero** processing — they marshal raw event data into a 
`System.Threading.Channels.Channel<T>` and return immediately (see risk R3).

- A consumer task reads the channel, runs all filtering/aggregation/resolution,
raises UI updates via the main `Dispatcher`, and appends CSV rows.

- UIA calls run on background threads with timeouts (they are cross-process COM
and can be slow/hang).



---



## 5. Screen Capture



**Decision:** one monitor per session (user picks at Start). Record with 
**ffmpeg as a subprocess**, behind an `IScreenRecorder` interface so a backend 
can be swapped later. Ship ffmpeg alongside JEM (bundled `vendor/ffmpeg/` or a 
configured absolute path; see §16). Include ffmpeg license notices in 
distribution.



**Primary backend: `ddagrab`** (Desktop Duplication API — GPU-side, per-output,
efficient). Requires an ffmpeg full build ≥ 6.1 for the `output_idx` option 
[VERIFY]. Example [VERIFY flags at implementation]:



~~~

ffmpeg -y -f ddagrab -output_idx <monitorIndex> -framerate 30 -i desktop ^

       -vf "fps=30,format=yuv420p" -c:v libx264 -preset veryfast -crf 23 
segment_0001.mkv

~~~



**Fallback backend: `gdigrab`** region capture (compatibility path for problem 
GPUs/drivers). Offsets are virtual-screen coordinates and **can be negative** 
for monitors left/above the primary [VERIFY]:



~~~

ffmpeg -y -f gdigrab -offset_x <X> -offset_y <Y> -video_size <W>x<H> -framerate
30 -i desktop ^

       -vf "fps=30,format=yuv420p" -c:v libx264 -preset veryfast -crf 23 
segment_0001.mkv

~~~



**Fidelity policy:** start HIGH — native resolution, 30 fps [TUNE]. Both fps 
and a `capture.scale` factor [TUNE 1.0] are config so fidelity can be reduced 
later to cut JAMS AI-token cost. **Do not** scale down before the sync-flash 
detection in §12 is proven tolerant of it.



**Encoding:** MP4 container, H.264. Encoder preference: `libx264 -preset 
veryfast -crf 23` [TUNE] everywhere for determinism; hardware encoders 
(`h264_nvenc` / `h264_qsv` / `h264_amf`) are an allowed config override [open 
decision §16]. Pixel format `yuv420p` for playback compatibility.



**Segments:** record each run segment as `.mkv` (crash-tolerant — an 
interrupted mp4 is unplayable; an interrupted mkv is recoverable). Finalize to 
a single `.mp4` on Save via the concat demuxer with stream copy (identical 
codec params across segments makes this safe) [VERIFY on real hardware]:



~~~

ffmpeg -y -f concat -safe 0 -i segments.txt -c copy <session>.mp4

~~~



**Clean stop:** send `q` on ffmpeg's stdin (documented graceful quit; 
flushes/muxes trailer). Wait up to 5 s [TUNE], then kill. Do **not** start 
ffmpeg with `-nostdin`.



**Why not SnagIt (explicitly):** SnagIt is built for *interactive* capture. It 
does not reliably expose (a) scripted/headless video start–stop with a 
**precisely known start instant**, (b) programmatic **per-monitor selection**, 
or (c) configurable **fps/resolution** — all three of which JEM's timeline sync
(§6) and automation (§12) require. Its presence on the author's machine is 
irrelevant to this decision.



**`IScreenRecorder` seam (concept, not code):** `Start(segmentPath, monitor, 
fps, scale)` / `StopAsync()` / event `OnFatalError`. ddagrab and gdigrab are 
two implementations selected by config + runtime probe.



---



## 6. Timeline & Synchronization (critical)



The CSV and the MP4 must share a clock so JEM events map to video timestamps 
for the JAMS diff.



**Session clock:** `System.Diagnostics.Stopwatch` (wraps 
`QueryPerformanceCounter`). All event timestamps are `int64` milliseconds of 
**active time** (defined below) from session start.



**Active time (decided):** the session clock counts only *unpaused* time:



~~~

active_ms(t) = wall_ms(t) − Σ (pause_end − pause_start)   for all pauses fully 
before t

~~~



During a pause the clock is frozen; events are not captured and video is not 
recorded (see §8). Because paused wall-time never enters the recording, the 
**concatenated video timeline equals the active-time timeline** — a 1:1 mapping
plus one constant offset. This is the elegant property the whole design leans 
on. Pause intervals are recorded in `session.json` for human reference only; 
they never appear in `events.csv`.



**Sync flash (reuse JAMS's proven approach):** recorder start latency is 
unknown and untrustworthy — so we never trust it. Sequence at session start:



1. Start ffmpeg segment.

2. Wait ~500 ms [TUNE] (ensures the flash lands *inside* the recording).

3. Show a full-screen, borderless, topmost **white WPF window on the selected 
monitor** for ~300 ms [TUNE]. Log a `sync_flash` row at the instant the window 
is shown.

4. Optionally repeat at session end (flash, keep recording ~500 ms [TUNE], then
stop) to measure clock drift.



**Offset derivation (done by the harness, §12):**



~~~

offset_ms   = flash_video_ms − flash_log_ms

video_t(e)  = e.t_ms + offset_ms

~~~



With an end flash: `drift = offset_end − offset_start`. If `|drift| > 250 ms` 
[TUNE], apply a linear correction across the session; otherwise treat offset as
constant. The flash is detectable in decoded frames regardless of container 
metadata, muxing delays, or recorder latency — which is exactly why it exists.



---



## 7. Data Schema



### 7.1 `events.csv` (one per session — the ground truth)



UTF-8, header row, RFC-4180 quoting, invariant-culture numbers, empty field = 
null, **append-only with flush after every row** (crash safety). Exact header:



~~~

kind,category,t_start_ms,t_end_ms,value_num,value_text,x,y,monitor,process,wind
ow_title,detail,key_category,confidence

~~~



These columns **mirror JAMS's canonical "measures" vocabulary** so validation 
is a direct diff.



| Column | Meaning |

|---|---|

| `kind` | `context_switch` \| `click` \| `keypress` \| `scroll` \| 
`sync_flash` \| `session` |

| `category` | `physical` \| `cognitive` \| `time` |

| `t_start_ms` | Active-time ms of event (or span start). |

| `t_end_ms` | Span end; empty for point events. |

| `value_num` | Numeric value (scroll notch count; flash duration). |

| `value_text` | Click button; scroll direction; display string for context 
switches; typed char iff opt-in. |

| `x`, `y` | **Monitor-relative** pixels (cursor minus monitor origin) — 
matches video pixels at native-res capture. Empty for keypress. |

| `monitor` | Monitor index (always the selected one; geometry lives in 
`session.json`). |

| `process` | Foreground process exe name, e.g. `msedge.exe`; `unknown` on 
access denial (risk R5). |

| `window_title` | Raw foreground window title at event time. |

| `detail` | Provenance-prefixed enrichment: `uia:https://…`, `title:git 
status`, `uia:PS C:\…`. Empty if none. |

| `key_category` | Keypress only: taxonomy in §10.5. |

| `confidence` | **Always `1.0`** — this is ground truth. (Best-effort 
*enrichment* strings in `detail` carry their provenance prefix so the harness 
can weigh them; the event itself is never uncertain.) |



### 7.2 JEM-kind → JAMS-kind mapping (the contract)



| JEM kind | JAMS kind | JAMS category | Notes |

|---|---|---|---|

| `context_switch` | `context_switch` | cognitive | Span: start = switch 
instant, end = next switch or session end. |

| `click` | `click` | physical | Point event. |

| `keypress` | `keypress` | physical | Point event; harness may aggregate to 
bursts/counts. |

| `scroll` | `scroll` | physical | Span with accumulated notches. |

| *(none)* | concepts / choices / sentiment | — | **JEM does not capture 
these.** AI-only; excluded from diff, reported separately by the harness. |



`sync_flash` and `session` rows are JEM-internal: the harness uses `sync_flash`
for alignment and ignores `session`.



### 7.3 Example rows



~~~

context_switch,cognitive,0,5230,,Edge - google.com,,,0,msedge.exe,Google - 
Microsoft Edge,uia:https://www.google.com/,,1.0

click,physical,1200,,,left,640,410,0,msedge.exe,Google - Microsoft Edge,,,1.0

keypress,physical,1800,,,,,,0,msedge.exe,Google - Microsoft 
Edge,,alphanumeric,1.0

scroll,physical,2000,2600,5,down,640,410,0,msedge.exe,Google - Microsoft 
Edge,,,1.0

~~~



### 7.4 `session.json` (per session)



Fields: `jem_version`, `project`, `scenario`, `session_id` (= timestamp 
basename), `started_utc`, `monitor` {`index`, `device`, `bounds` 
{x,y,width,height}, `dpi`}, `video` {`file`, `backend`, `fps`, `width`, 
`height`, `encoder`}, `clock` {`qpc_frequency`}, `sync` {`flash_log_ms`, 
`flash_duration_ms`, `end_flash_log_ms` (nullable)}, `pauses` [ 
{`pause_started_wall_ms`, `pause_ended_wall_ms`, `active_ms_at_pause`} ], 
`totals` {`active_ms`, `clicks`, `keypresses`, `scrolls`, `context_switches`}, 
`config` (effective config snapshot incl. `capture_key_text`).



---



## 8. Session Model & Folder Layout



**Naming:** `<Project>` + `<Scenario>` (sanitized for filesystem). All three 
session files share one timestamp basename:



~~~

<root>/<Project>/<Scenario>/<yyyyMMdd-HHmmss>.csv

<root>/<Project>/<Scenario>/<yyyyMMdd-HHmmss>.mp4

<root>/<Project>/<Scenario>/<yyyyMMdd-HHmmss>.json

~~~



Default `<root>`: `%USERPROFILE%\Documents\JEM` [TUNE / open decision].



**Controls & states:**



| Control | Behavior |

|---|---|

| **Start** | Validates Project/Scenario/monitor; creates folder; starts clock,
hooks, recorder; fires sync flash. State → Recording. |

| **Pause / Resume** | One toggle button. Pause: hooks stop capturing, clock 
freezes, current recorder segment is cleanly stopped, open scroll span and open
context span are closed at `active_ms_at_pause`, pause interval appended to 
`session.json`. Resume: new recorder segment starts; clock resumes. **Paused 
time leaves no trace in video or CSV** — by design. |

| **Stop** | Hooks detach, clock stops, optional end flash, final segment 
stopped. State → Ended (unsaved). |

| **Save** | Finalizes: concat segments → `.mp4`, write `session.json`, delete 
segments. (CSV already exists — it was append-live.) A **Discard** option at 
this point deletes the session folder. |



**Pause strategy = segmented recording (decided).** Rejected alternative — keep
one recorder running and post-trim paused ranges — because paused screen 
content (which the user explicitly chose not to record, possibly for privacy) 
would still land on disk. Segmentation also keeps the video timeline identical 
to active time with zero post-processing math.



---



## 9. Live UI



One small, always-available (optionally topmost [TUNE]) window:



- Fields: **Project**, **Scenario**, **monitor picker** (list monitors via 
`EnumDisplayMonitors` + `GetMonitorInfo`), recorder backend + fps shown 
read-only from config.

- Controls: Start / Pause-Resume / Stop / Save (+ Discard after Stop). Status 
line: `● REC` / `❚❚ PAUSED` / `■ ENDED`, active-time clock, per-kind counts.

- **"Capture key text" opt-in checkbox (default OFF)** with a visible warning 
(§10.5).



**Live table (the spec, exactly):**



- A scrolling `DataGrid`, **newest activity at TOP** (insert at index 0).

- **One row per context shift** — the click/keypress/scroll stream goes to the 
CSV only, never to this table.

- Column header: **"Window"**. Value rules, in priority order:

  1. Edge (`msedge.exe`): `Edge - <host>` when the URL is known (§10.3), else 
`Edge - <parsed tab title>` (§10.2 title parser).

  2. Terminal (Windows Terminal / PowerShell / cmd / conhost): `<App> - 
<command-or-title>` when obtainable (§10.4), else app/window title.

  3. Everything else: the window title; fall back to process name when the 
title is empty.

- Plus a `Time` column (active `hh:mm:ss`). The same display string is written 
to the CSV `value_text` so table and truth agree.



---



## 10. Technical Deep-Dives



### 10.1 Context-Switch Detection



- Hook with `SetWinEventHook(EVENT_SYSTEM_FOREGROUND, …, WINEVENT_OUTOFCONTEXT,
…)` (`EVENT_SYSTEM_FOREGROUND = 0x0003`). Out-of-context = events delivered to 
our message loop, no DLL injection into other processes.

- **CRITICAL SUBTLETY:** switching browser tabs (Edge) does **not** change the 
foreground `hwnd` — it changes the window **title** on the same hwnd. Therefore
also hook `EVENT_OBJECT_NAMECHANGE = 0x800C`, but only act when `idObject == 
OBJID_WINDOW (0)` **and** `hwnd == current foreground hwnd`.

- NAMECHANGE can storm (media sites, spinners, terminals). Coalesce: on a 
NAMECHANGE burst, wait for a 200 ms [TUNE] quiet period, resolve once, and emit
a `context_switch` row **only if the resolved context identity actually 
changed** (process + semantic title/URL).

- Resolve: `GetWindowThreadProcessId` → PID → `QueryFullProcessImageName` for 
exe path (fallback: process name via `OpenProcess` limited query; fallback: 
`unknown`). Title via `GetWindowText` (cross-process sends `WM_GETTEXT`; if the
target is hung, time out and use `unknown` — do not block the pipeline).

- **Monitor filtering:** `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)`; 
keep the event only if the returned `HMONITOR` equals the selected monitor's. 
Foreground windows on other monitors are ignored entirely.

- The **open** context span is held in memory; its row is appended to the CSV 
when it **closes** (next switch, pause, or stop) with full start/end. Accepted 
limitation: a hard crash loses only the currently-open span (§14 mitigation: 
periodic `*.partial` checkpoint [TUNE]).



**Edge title parser (unit-test target):** strip trailing ` - Microsoft Edge` 
(and any profile suffix variant [VERIFY against current Edge]); `New tab` maps 
to `Edge - New tab`; result feeds the `Edge - <tab title>` fallback display 
string.



### 10.2 Input Hooks



- `SetWindowsHookEx(WH_MOUSE_LL = 14, …)` and `(WH_KEYBOARD_LL = 13, …)` on the
dedicated pump thread (§4). Every callback enqueues and returns — 
sub-millisecond. (`LowLevelHooksTimeout` will silently detach slow hooks: risk 
R3.)

- **Clicks:** `WM_LBUTTONDOWN (0x0201)`, `WM_RBUTTONDOWN (0x0204)`, 
`WM_MBUTTONDOWN (0x0207)`; optionally X buttons `WM_XBUTTONDOWN (0x020B)` 
[TUNE]. Point events; `value_text` = `left|right|middle|x1|x2`; `x,y` from 
`MSLLHOOKSTRUCT.pt`, converted to monitor-relative.

- **Scrolls:** `WM_MOUSEWHEEL (0x020A)` / `WM_MOUSEHWHEEL (0x020E)`; delta in 
units of `WHEEL_DELTA = 120`. **Aggregate into scroll spans:** accumulate 
notches; close the span on (a) direction change, (b) 800 ms [TUNE] idle, or (c)
context switch / pause / stop. Row: `value_num` = total notches, `value_text` =
dominant direction (`up|down|left|right`), span start/end, `x,y` at span start.

- **Keyboard:** `WM_KEYDOWN (0x0100)` / `WM_SYSKEYDOWN (0x0104)` → one 
`keypress` row per **physical press**: suppress auto-repeat by tracking per-VK 
down-state (reset on `WM_KEYUP (0x0101)` / `WM_SYSKEYUP (0x0105)`). Key-up 
messages are consumed for state, never logged. `key_category` per §10.5.

- **Monitor filtering (mouse):** `MonitorFromPoint(cursorPt, 
MONITOR_DEFAULTTONEAREST)`; drop events not on the selected monitor. Keyboard 
goes to the foreground window, which was already monitor-filtered at switch 
time.

- **Injected events:** LL structs carry `LLMHF_INJECTED` / `LLKHF_INJECTED` 
(set by `SendInput`/automation tools). Config `include_injected_events` — 
proposed default **true** (they are real screen activity, and §14's integration
test needs them). Open decision §16.

- `CallNextHookEx` always called; never swallow the chain.



### 10.3 Edge URL (best-effort bonus)



- Via UIA (`System.Windows.Automation`, UIAutomationClient): from the Edge 
top-level `AutomationElement`, `FindFirst` a `ControlType.Edit` descendant 
whose `Name` matches the address/search bar (English builds: contains 
"address"; localization is an open decision). Cache the element per hwnd; 
invalidate on `ElementNotAvailableException`.

- Read `ValuePattern.Current.Value` → full URL. If empty or non-http(s) 
(`edge://`, new tab), fall back to the title parser. Display: `Edge - <host>`; 
CSV `detail` = `uia:<full url>`.

- Run on a background thread with a 500 ms [TUNE] timeout; any failure → silent
title fallback. **Version fragility is real** (Edge changes its UIA tree); 
isolate behind a resolver interface with a config kill-switch (risk R4).



### 10.4 Terminal Command (best-effort, hardest — honest expectations)



Terminal-ish processes (config-extensible): `WindowsTerminal.exe`, `wt.exe`, 
`powershell.exe`, `pwsh.exe`, `cmd.exe`, `conhost.exe`. Two sources, both 
recorded with provenance:



1. **Window title (`title:…`)** — Windows Terminal tab title often reflects the
shell/cwd (user-configurable); conhost/cmd titles show the exe path or 
`Administrator: …`. Reliably gives *app identity*, rarely the actual command.

2. **UIA `TextPattern` scrape (`uia:…`)** — read the terminal text buffer, take
the last non-empty line as the active prompt, heuristically strip prompt 
decorations (`PS …>`, `$`, `>`). Fragile: custom renderers, huge buffers, 
alt-screen apps (vim, less) will defeat it.



**Stated reliability: LOW. This is an explicit "if possible" feature.** Never 
block or degrade the context-switch pipeline for it; `detail` stays empty when 
nothing is found. Do not over-promise this in docs or demos.



### 10.5 Privacy



- **Keystroke CONTENT is OFF by default.** Ground truth needs timing + counts, 
not text. Default row: timestamp + `key_category` only; harness derives 
counts/bursts.

- `key_category` taxonomy (decided):



  | Category | Keys |

  |---|---|

  | `alphanumeric` | A–Z, 0–9, punctuation/symbol keys |

  | `whitespace` | Space, Enter |

  | `navigation` | Tab, arrows, Home, End, PageUp, PageDown |

  | `editing` | Backspace, Delete, Insert |

  | `modifier` | Shift, Ctrl, Alt, Win (logged but excluded from effort counts 
by the harness [TUNE]) |

  | `other` | Function keys, Escape, everything else |



- **Opt-in "capture key text" toggle** (default off, on-screen warning): then 
`value_text` carries the printable character, or a key *name* (`Enter`, `F5`) 
for non-printables — never a raw newline in CSV.

- **The video itself can show typed text and passwords.** Scenario guidance 
(must ship in README): use test accounts, never real secrets, prefer the Pause 
control liberally (paused time is never recorded — §8).



---



## 11. Configuration (`jem.config.json`)



~~~json

{

  "session_root": "%USERPROFILE%\\Documents\\JEM",

  "capture": { "fps": 30, "scale": 1.0, "backend": "ddagrab", "encoder": 
"libx264", "crf": 23 },

  "ffmpeg_path": "vendor/ffmpeg/ffmpeg.exe",

  "sync": { "flash_duration_ms": 300, "pre_flash_delay_ms": 500, "end_flash": 
true },

  "hooks": { "include_injected_events": true, "scroll_idle_close_ms": 800, 
"namechange_quiet_ms": 200 },

  "privacy": { "capture_key_text": false },

  "enrichment": { "edge_url": true, "terminal_command": true, "uia_timeout_ms":
500 }

}

~~~



Every [TUNE] value in this document lives here, not in code.



---



## 12. JAMS Validation Harness (the payoff — J6 deliverable)



Lives in the **JAMS repo** (Python suggested); JEM only guarantees the 
artifacts. Workflow per JEM session:



1. **Probe** the mp4 with `ffprobe` (fps, duration).

2. **Detect the sync flash:** decode downscaled grayscale (`ffmpeg -i 
session.mp4 -vf scale=64:36 -f rawvideo -pix_fmt gray -`), per-frame mean luma;
flash = first run of ≥2 [TUNE] frames with mean > 245 [TUNE]. Compute 
`offset_ms` (and end-flash drift if present) per §6.

3. **Run the mp4 through the JAMS worker pipeline** → detected measures with 
video timestamps.

4. **Align** JAMS timestamps to the JEM log timeline via the offset.

5. **Match per kind:** point events (click/keypress) matched greedily, 
one-to-one, within ±500 ms [TUNE]; spans (scroll, context_switch) matched by 
temporal IoU ≥ 0.5 [TUNE].

6. **Metrics per kind:** TP/FP/FN, precision, recall, F1, and count accuracy `1
− |detected − true| / true`. AI-only kinds reported separately (no ground truth
— §7.2).

7. **Report:** machine-readable JSON + human Markdown summary.



This report is what graduates JAMS's weight-0 measures and feeds 
threshold/prompt tuning and training data. **It is also JEM's ultimate 
acceptance test** (§14).



---



## 13. Phased Roadmap



Each phase ends in an independently runnable build with a demo-able acceptance 
check.



| Phase | Scope | Acceptance |

|---|---|---|

| **J0** — Skeleton + session mgmt + CSV | WPF shell (Project/Scenario/monitor 
picker, controls), folder creation, SessionClock with active-time math, CSV 
writer with full schema, `session` row, config loader. | Start→Stop produces a 
well-formed `events.csv` (session row) + `session.json` skeleton in the right 
folder. |

| **J1** — Input hooks | Dedicated hook thread, channel pipeline, 
clicks/keys/scroll aggregation, monitor filtering, key categorizer. | Manual 
matrix (each button, typing, wheel both directions) yields correct rows; 
SendInput integration test green. |

| **J2** — Context switches + live table | WinEvent hooks (FOREGROUND + 
NAMECHANGE), resolver, debounce, DataGrid per §9. | Switching apps **and Edge 
tabs on the same hwnd** each produce exactly one table row + CSV span row. |

| **J3** — Recording + sync flash | ffmpeg ddagrab (+gdigrab), segments, sync 
flash, concat finalize to mp4. | Playable mp4 per session; flash detectable by 
the §12 decode snippet; event↔video alignment spot-check within ±500 ms. |

| **J4** — Edge URL + terminal best-effort | UIA resolvers with fallbacks, 
provenance prefixes. | Edge navigations resolve URL ≥80% of the time in a 
scripted run [TUNE]; failures degrade to title; terminal detail appears when 
obtainable, `unknown` never crashes. |

| **J5** — Pause/resume + polish + publish | Segmented pause + active-time, 
Save/Discard, settings surface, single-file self-contained publish, ffmpeg 
bundling + license notices, README (incl. privacy hygiene). | Paused content is
absent from video and CSV; concatenated mp4 still aligns; single-file exe runs 
on a clean Windows machine. |

| **J6** — JAMS validation harness | §12 script in the JAMS repo. | On a 
choreographed session (known script of clicks/keys/scrolls/switches), harness 
emits a metrics report; numbers are sane vs. the choreography. |



**Ordering justification (kept as specified, with reasoning):** the clock+CSV 
come first because *every* later phase sinks into them. Input hooks precede 
context detection because they build the hook-thread/channel infrastructure the
WinEvent work reuses. Recording waits until there is capture to align, and the 
sync flash is delivered *with* recording because they are inseparable. 
Enrichment (J4) sits after the core pipeline is stable. Pause is late 
**deliberately** — it perturbs the recorder (segments), the clock (active 
time), and span closing, so it lands only after an end-to-end path exists; the 
alternative (pause in J1) was rejected for exactly that reason. The harness is 
last but is the final gate.



---



## 14. Testing Strategy



- **Unit (Jem.Core, high value, easy):** CSV serializer round-trip (quoting, 
nulls, unicode); Edge title parser (table-driven); key categorizer (every VK in
taxonomy); scroll aggregator state machine (direction change / idle close / 
switch close); active-time & pause math (multiple pauses, pause-at-boundary); 
sync-offset & drift math; monitor rect containment/coordinate conversion.

- **Hooks are hard to unit test — say so.** Isolate delivery behind an 
event-source seam so synthetic events can be fed into the real processing 
pipeline without installing hooks.

- **Integration:** `tools/Jem.TestInjector` uses `SendInput` to generate a 
*known* choreography (N clicks at known spots, typed string, K wheel notches) 
into a test window while JEM records; assert the CSV matches within tolerance. 
Requires `include_injected_events: true`.

- **E2E acceptance:** the J6 JAMS-diff harness on choreographed sessions is the
ultimate gate — it validates capture, sync, schema, and video in one shot.

- **Manual matrix** (document in README): multi-monitor placement (negative 
coords), Edge tab switching, elevated apps, long-session drift, pause stress 
(rapid pause/resume), crash recovery (kill mid-session → CSV intact up to last 
flush, only open span lost; `*.partial` checkpoint [TUNE] if implemented).



---



## 15. Build, Delegation & Token Economics



Follow the manage-and-delegate pattern:



- A **senior model acts as architect**: owns this spec, writes per-phase 
mini-specs, reviews diffs, decides on [TUNE]/[VERIFY] resolutions.

- **Cheaper CLI coding agents do the typing**, one phase (or one component) per
session, given only: this plan, the phase mini-spec, and the relevant existing 
files — never the whole repo history.

- **Tests are the delegation contract**: a phase is "done" when its acceptance 
check + unit tests pass, not when the agent says so.

- Commit early/often per phase so context windows stay small and reviewable.



---



## 16. Open Decisions (genuinely the author's call)



1. Default session root (proposal: `Documents\JEM`).

2. Default for `include_injected_events` (proposal: `true`).

3. Chrome support: UIA approach generalizes — in scope now or Edge-only for v1?
(proposal: Edge-only, config-flag-ready.)

4. End-of-session sync flash default on/off (proposal: on; costs ~1 s).

5. Encoder default: `libx264` everywhere vs. auto-detect hardware encoder 
(proposal: libx264; hardware as opt-in).

6. Emit aggregate keypress-burst rows in addition to per-key rows? (proposal: 
no — per-key only; harness aggregates.)

7. Global hotkey for Pause? (proposal: no in v1 — collision risk; button only.)

8. Session retention/cleanup policy (proposal: none in v1; manual).

9. Bundle ffmpeg in repo/installer vs. download-at-setup (licensing notices 
required either way).

10. X-button (`x1`/`x2`) click capture (proposal: capture them; near-free).

11. Localization assumption for UIA names ("Address and search bar" is English)
— non-English Windows in scope?



---



## 17. Risks (ranked)



| # | Risk | L/I | Mitigation |

|---|---|---|---|

| R1 | **Timeline misalignment** (recorder start latency, container delays, 
drift) silently corrupts the diff — JEM's entire purpose. | M / H | Sync flash 
(proven in JAMS) instead of trusting clocks; flash fired *after* recorder 
start; end flash measures drift; harness asserts offset sanity; ±500 ms 
acceptance gate. |

| R2 | **Pause segmentation glitches** (concat timestamp discontinuities, codec
param mismatch). | M / H | mkv segments + concat `-c copy` with identical 
encoder settings; validate output with ffprobe; fallback config: 
continuous-record + logged gap intervals (with the §8 privacy caveat surfaced).
|

| R3 | **Hook loss/stall**: OS detaches slow LL hooks (`LowLevelHooksTimeout`);
pump starvation. | M / H | Trivial callbacks → channel; dedicated pump thread; 
watchdog that re-installs hooks if event flow dies mid-session; surface hook 
health in status line. |

| R4 | **UIA fragility** (Edge/Terminal updates break resolvers). | H / L | 
Bonus features only; title fallback always works; element cache + invalidate; 
kill-switch config; isolated resolver interfaces. |

| R5 | **Elevation gaps**: elevated/protected foreground apps deny 
`QueryFullProcessImageName` and UIA. | M / M | Graceful `unknown`; document 
"run JEM as administrator" option; note gaps in the harness report rather than 
failing. |

| R6 | **Privacy exposure**: video shows typed secrets; opt-in key text 
misused. | M / H | Key text OFF by default + on-screen warning; README scenario
hygiene (test accounts, liberal Pause — paused time is never recorded); no 
telemetry, no upload, ever. |

| R7 | **NAMECHANGE storms** (media titles, spinners) flood context rows. | M /
L | Quiet-period coalescing + identity-compare before emitting (§10.1); 
validate against real Edge/YouTube early in J2. |



---



## Appendix A — Windows API & Constants Reference



| Area | APIs / constants |

|---|---|

| LL hooks | `SetWindowsHookEx`, `CallNextHookEx`, `UnhookWindowsHookEx`; 
`WH_MOUSE_LL = 14`, `WH_KEYBOARD_LL = 13`; `WM_LBUTTONDOWN 0x0201`, 
`WM_RBUTTONDOWN 0x0204`, `WM_MBUTTONDOWN 0x0207`, `WM_XBUTTONDOWN 0x020B`, 
`WM_MOUSEWHEEL 0x020A`, `WM_MOUSEHWHEEL 0x020E`, `WM_KEYDOWN 0x0100`, `WM_KEYUP
0x0101`, `WM_SYSKEYDOWN 0x0104`, `WM_SYSKEYUP 0x0105`; `WHEEL_DELTA = 120`; 
flags `LLMHF_INJECTED`, `LLKHF_INJECTED`; structs `MSLLHOOKSTRUCT`, 
`KBDLLHOOKSTRUCT` |

| Window events | `SetWinEventHook` (`WINEVENT_OUTOFCONTEXT = 0x0000`), 
`UnhookWinEvent`; `EVENT_SYSTEM_FOREGROUND = 0x0003`, `EVENT_OBJECT_NAMECHANGE 
= 0x800C`; `OBJID_WINDOW = 0` |

| Window/process | `GetWindowThreadProcessId`, `QueryFullProcessImageName`, 
`GetWindowText`, `GetWindowTextLength` |

| Monitors | `EnumDisplayMonitors`, `GetMonitorInfo`, `MonitorFromWindow`, 
`MonitorFromPoint`, `MONITOR_DEFAULTTONEAREST` |

| Clock | `System.Diagnostics.Stopwatch` (wraps `QueryPerformanceCounter` / 
`QueryPerformanceFrequency`) |

| UIA | `System.Windows.Automation` (UIAutomationClient): `AutomationElement`, 
`ControlType.Edit`, `ValuePattern`, `TextPattern` |

| Testing | `SendInput` (integration driver) |



*End of plan. Build J0 first; every phase is independently runnable; the J6 
harness is the final gate.*
---

## Claude's review (2026-07-20)

**Verdict: build-ready, with two corrections and one operational note below.** The design is sound: the active-time clock (paused time leaves no trace so the concatenated video timeline equals the CSV timeline), the flash-after-recorder-start sync (never trust ffmpeg's start instant), the `.mkv`-segments-then-concat crash tolerance, the hooks-do-zero-work channel pipeline, monitor-relative `x,y` matching video pixels, and the CSV schema mirroring JAMS's `measures` vocabulary are all correct and well-reasoned. The two hardest calls — hooking `EVENT_OBJECT_NAMECHANGE` because Edge tab switches keep the same hwnd, and treating the JAMS-diff harness as JEM's own acceptance test — are exactly right.

### Correction 1 (required — per-segment alignment drift)
Pause/resume creates a **new ffmpeg segment per active interval**, and every segment has its own startup latency with **no flash of its own**. The single start-of-session flash calibrates only segment 0; after the first resume, the concatenated video runs progressively shorter than active-time and alignment drifts (~one startup-latency per resume). The plan's J5 claim "concatenated mp4 still aligns" is not actually delivered by a single flash.
**Fix:** fire a sync flash at the start of **every** segment (session start *and* every resume), and have the §12 harness detect **all** flashes and build a **piecewise active-time→video-time map** (one offset per segment), not a single global offset. This reuses the existing flash machinery and makes each segment self-calibrating. Update §6, the §7.4 `sync` block (store a list of `flash_log_ms` per segment), §11 config, and the J5 acceptance to assert multi-segment alignment explicitly.

### Correction 2 (required — ddagrab invocation syntax)
The §5 example `ffmpeg -f ddagrab -output_idx <n> -i desktop` is **not** ddagrab's real syntax and will fail. ddagrab is a **libavfilter source**, invoked via lavfi, e.g.:
`ffmpeg -f lavfi -i "ddagrab=output_idx=<n>:framerate=30" -vf format=yuv420p -c:v libx264 -preset veryfast -crf 23 segment_0001.mkv`
(gdigrab's `-f gdigrab -offset_x/-offset_y/-video_size -i desktop` form in the fallback **is** correct.) The plan already tags this `[VERIFY]`; treat this as the resolved value — verify the exact `output_idx`/`framerate` option names against the bundled ffmpeg build, but do not build on the `-f ddagrab` form.

### Operational note (not a blocker)
For **validation-grade** recordings (the ones fed to the JAMS harness), prefer a **single unpaused take** — it sidesteps segment-boundary alignment entirely and keeps the ground truth simplest. Pause/resume (J5) stays a real feature for long authoring sessions, but the calibration corpus doesn't need it. Worth one line in the README.

### Confirmed accurate (spot-checked, no change needed)
`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` + `EVENT_OBJECT_NAMECHANGE`; `WH_MOUSE_LL`/`WH_KEYBOARD_LL` requiring a message pump on the installing thread; `WM_MOUSEWHEEL` 120-unit delta; gdigrab negative offsets for monitors left/above primary; concat demuxer with `-c copy` requiring identical codec params across segments; graceful `q`-on-stdin stop. Every enrichment feature (Edge URL via UIA `ValuePattern` on the address-bar Edit element; terminal command via title + UIA `TextPattern`) is correctly scoped as best-effort with title fallback.

### Ties back to JAMS
This plan is the concrete instrument for the graduation problem tracked in `docs/CHRIS-TODO.md` (the "record F10 ground-truth fixtures" item): a JEM session is exactly a `(video, truth-log)` pair, and §12's per-kind precision/recall is what flips JAMS's clicks/keypresses/scrolls/context_switch measures off weight 0. Build JEM, record a handful of scenarios, run the harness, graduate the weights — same flywheel, now with an instrument.
