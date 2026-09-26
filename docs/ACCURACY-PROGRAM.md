# JAMS accuracy program: JEM, JAMS, and the customer loop

September 25, 2026. Status: **proposed, awaiting Chris's go-ahead.** This plan builds on
`JEM-HILLCLIMB-2026-09-09.md`, `JEM-EVAL-RESCORE-2026-09-18.md`, `EVALUATION-MATRIX.md`,
`journeys/`, and JEM's `PROJECT_PLAN.md` §12 / `docs/JAMS-HARNESS-BRIEF.md`. It does not replace
them.

## 1. The goal, stated so it can be measured

The goal: **JAMS's analysis is near 100% accurate.** "Accuracy" covers five separate claims, and
each needs its own measurement. Pooling them into one number is how the IANA and Outlook zeros
misled strategy.

| Level | Claim | Measured against | Why it matters |
|---|---|---|---|
| L0 Time | A JAMS timestamp points at the moment it names | JEM sync flashes, JEM event times | Deep links are a patent claim; every other level depends on it |
| L1 Events | Each detected event happened, and each real event was detected | JEM CSV (clicks, keys, scrolls, context), narration script (speech, sentiment) | Per-provider precision/recall/F1, stratified by visibility |
| L2 Rates | Per-minute rates and totals are right | JEM totals per segment | The Effort Score uses rates, so L2 can be right even where L1 is imperfect |
| L3 Friction | JAMS flags the stretches where the journey was actually hard, and not the easy ones | Friction deliberately injected at known times | The customer promise: "show me where it hurts" |
| L4 Change | After a fix, JAMS reports the right direction and rough size of the improvement | Paired before/after recordings of a known fix | The customer's loop ends with a comparison |

"Near 100%" is a realistic target at L3 and L4, and at L1 for events that are **visible in the
pixels or audible in the audio**. It is not achievable for events that leave no trace in the
recording, like the Outlook foreground switch (screen delta 0.039). Those are reported as
out-of-scope for a video analyser, never counted as misses and never tuned toward (rescore doc,
"What this changes").

## 2. The three personas are one loop

```
           ┌──────────────────────── JEM developer ────────────────────────┐
           │  Is the ruler straight? JEM log vs. what actually happened    │
           │  (runner intent log + independent input witness + pixels)     │
           └───────────────────────────────┬───────────────────────────────┘
                                           │ trusted truth
           ┌────────────────────── JAMS developer ─────────────────────────┐
           │  record (JEM) → process (JAMS website) → diff vs. JEM truth   │
           │  → change one provider → re-score dev split → holdout gate    │
           └───────────────────────────────┬───────────────────────────────┘
                                           │ accurate measures
           ┌────────────────────────── Customer ───────────────────────────┐
           │  record → JAMS finds friction → fix product → re-record →     │
           │  JAMS compares.  We run this ourselves on a fixture app with  │
           │  friction injected at known times: the end-to-end acceptance  │
           └───────────────────────────────────────────────────────────────┘
```

The customer loop is the acceptance test for the whole program. It is the only level where "JAMS
is accurate" means what a buyer means by it. The JEM loop comes first because every JAMS number
inherits JEM's errors.

## 3. Where we actually are (review findings)

### 3.1 Every JEM session on disk

| Session | What it is | Scored so far | Through the website? | Disposition |
|---|---|---|---|---|
| `Test/Email Review/20260919-204551` | **6 min human session**, 40 clicks, 60 keys, 27 scrolls, 24 context spans | Context switch F1 **0.346** (Sept 25, §3.3); physical kinds never | No | Highest-value asset. Score all kinds; website run on the **local stack only** (real mailbox on screen) |
| `D:/JEM/Untitled/Untitled/20260926-011331` | 2.2 min human session (Edge, ChatGPT, File Explorer), spoken comments for JEM | Context switch F1 0.533 locally (Sept 25); end drift **-194 ms** | Blocked (see §3.4) | JEM bug evidence (§3.4); no audio, so the spoken comments are lost |
| `00-browser-calibration/20260909-181329` | Controlled fixture (onboarding, checkout, recovery) | Context switch F1 0.889 | No | Keep as dev set; score physical kinds |
| `.../20260909-133114` | IANA website | F1 0.0, near-noise band | No | Keep as the "subtle" stratum only; do not hill-climb on it |
| `.../20260909-133839` | Outlook | F1 0.0, invisible truth | No | Keep as a proxy-divergence example, not a test |
| `.../20260909-132941`, `133628` | Recorder-only calibration takes | Excluded | No | Use for JEM sync checks only |
| `.../20260909-134129` | 4.4 h, unattended after interruption | Exceeds probe limit | No | Trim a 15 min window as an idle false-positive probe |
| `01-information-finding/20260907-225707` | 2.2 h, 12 events total | Exceeds probe limit | No | Same: idle false-positive probe |
| `01-information-finding/20260908-011400` | **Crashed session**: `.seg0.mkv` 1.4 GB unreadable, no manifest, 1 keypress at 43,385,737 ms (~12 h) | n/a | n/a | **JEM bug evidence**: crash recovery and runaway sessions (§6) |
| `Untitled/…`, `asdfasd/…` | Metrics-only, no video | n/a | n/a | Excluded by contract (Amendment A2) |

### 3.2 Gaps, ranked by how much they limit the goal

1. **No JEM capture has ever gone through the website.** All scoring used the local provider
   harness (`jem_eval.py`), which runs one provider on a locally normalized file. The production
   path (upload, finalize, CFR normalization in the worker, all providers, scoring, report) has
   only seen synthetic fixtures and an 8-second clip. Parity is unproven.
2. **Only context switches are scored.** Physical providers (clicks, keypresses, scrolls) ship at
   weight 0 and have never been compared against real JEM truth. On the synthetic fixture, click
   precision is **4.5%** (TP 6, FP 126; pre-launch review T4).
3. **JEM records no audio, so the customer-facing core is unvalidated.** In the report,
   "frustration" is narration sentiment (`report-moments.ts`, threshold −0.5). Transcription, sentiment and
   segmentation have no ground truth from any JEM session. The sync tone (JEM commit `23fc1de`)
   anticipates an external mic, but nothing consumes it yet.
4. **The corpus is three scorable sessions.** The 56 designed journeys (`journeys/corpus.json`)
   were written before the visibility finding and have not been critiqued or captured.
5. **Capture needs a human at the keyboard.** JEM has no automation surface (no CLI or control
   channel). The TestInjector only does a fixed click/type/wheel choreography.
6. **JEM itself has not been independently checked.** Its CSV is trusted because it comes from
   hooks. Nothing compares it against a second witness. Known JEM issues: the Sept 8 crash above;
   gdigrab at 4K delivers **15 fps effective** against a 30 fps config (`controlled-eval.json`
   probe), which puts a 67 ms quantization floor under every JAMS timing number and pushes the
   scroll provider toward its known low-fps undercount (T6); ddagrab multi-monitor mapping is still
   pending.
7. **Timing misses its own gate.** Matched context-switch error is mean 178 ms, p95 313 ms, against
   the 250 ms cross-stage gate.
8. **The customer loop has never been exercised end to end** with known friction. F7 comparison
   exists but has never been checked against a before/after pair whose true difference is known.

### 3.3 First score on real human footage (Email Review, Sept 25)

Default detector, unchanged tolerances. Sync validated: offset −64 ms, end drift −15 ms. Effective
capture rate **12.5 fps** (4K gdigrab, configured 30).

| TP | FP | FN | Precision | Recall | F1 | FP/min | Timing mean / p95 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 9 | 25 | 9 | 0.265 | 0.500 | **0.346** | 5.5 | 96 / 243 ms |

On the only unscripted human session, the context-switch provider scores F1 0.35, far below the
controlled fixture's 0.889. Three findings follow:

1. **Most of the false positives are probably correct, and the truth is what's wrong.** 16 of the
   25 fall between 12 s and 119 s, a stretch where JEM logged no foreground change: Chris was in
   one Outlook window, opening one email after another. The screen changed completely each time,
   but the window title did not. Whether opening a different email is a context switch is a
   **definition question the patent has to answer**, not a detector bug. Phase 3 therefore labels
   two kinds separately: *app/window switch* (JEM truth) and *in-app content change* (page, email,
   tab, dialog; labeled from the runner's intent log or by hand). JAMS gets scored against each
   separately. Tuning the detector against today's truth would teach it to ignore real screen
   changes.
2. **Half the real switches were missed,** and the misses sit in the near-noise band (for example
   0.35 and 0.55 at 3.4 s and 129.6 s). This is the rescore's IANA problem again, now on human
   footage.
3. **Evaluator defect:** the `context_switch_proxy_only` stratum counts every detection as a false
   positive even when the session has no proxy-only truth (34 FP against 0 expected). Detections
   need attributing to the stratum of their nearest truth, or reporting once. Fix in component D.

**Privacy:** this session shows Chris's real mailbox. It is processed on the **local** stack only,
never uploaded to staging, and never committed. Only metrics leave the machine.

### 3.4 JEM bugs found in the Sept 25 session

1. **No audio capture at all.** The recorder builds a screen-only ffmpeg command, so narration
   (including spoken feedback about JEM) is silently lost. Microphone capture moves into Phase 2
   as a must-have, not an optional external recorder.
2. **Scroll spans are attributed when they close, not when they happen.** `EmitScrollSpan` stamps
   `CurrentContext()` at emit time. 2 of 11 scrolls went to the wrong app: an Explorer scroll
   logged as `msedge.exe`, and an Edge scroll logged as `Jem.App.exe` because it stayed open ~12 s
   until Stop. Video frames confirm the cursor positions. The fix exists on
   `codex/jem-ground-truth-hardening` (commit `58fd9b9`, a WIP checkpoint) but never reached
   `main`, which is what `run.ps1` runs. The Sept 9 report describes it as done.
3. **Drift.** End drift -194 ms over 134 s, against 5 to 29 ms before, at 13.2 fps effective
   capture. Sessions longer than about 3 minutes would breach the 250 ms gate at this rate.
4. **Proxy noise in context truth:** a 244 ms title flicker during page load and a 1 s SafeLinks
   redirect both count as context switches.
5. Minor: empty project/scenario accepted (`Untitled/Untitled`), `jem_version` still `0.0.0-j0`,
   monitor bounds report `x: 1` for a monitor that should start at 0.

Evaluator defect found at the same time: a detection at 133,600 ms, which is the **end sync
flash**, is scored as a false positive. Sync-flash windows must be masked (component D).

### 3.5 First JEM recording processed through the website (Sept 26)

Session `20260926-011331` was uploaded to staging through the real UI by
`apps/web/e2e/upload-recording.spec.ts` (run `ad6c1f77`, status `partial`: no audio, so no
transcript or sentiment). Scored against JEM with the +52 ms sync offset:

| Measure | Truth | Website | TP / FP / FN | Precision | Recall | Notes |
|---|---:|---:|---|---:|---:|---|
| Context switch | 7 | 7 (+2 on sync flashes) | 4 / 3 / 3 | 0.57 | 0.57 | **Identical to the local harness**: pipeline parity holds. The 3 FPs are File Explorer content changes JEM does not log (decision 5) |
| Clicks | 24 | 8 | 6 / 2 / 18 | 0.75 | 0.25 | Weight 0 |
| Scrolls | 11 spans, 81 notches | **0** | 0 / 0 / 11 | n/a | **0.00** | Complete miss. Capture was 12.6 fps and the scrolled region was one window, not the whole screen |
| Keypresses | 24 | 0 | n/a | n/a | 0.00 | Detector listens for keyboard sound; no audio track. JEM J7a now records audio |

The Default weight profile scores only context switches, time and speech/sentiment, so on a silent
recording the Effort Score is driven entirely by context switches, and 3 of 7 of those were
false. That is the concrete case for the hill-climb order in Phase 4.

### 3.6 First narrated JEM session through the website (Sept 26, JEM 0.7.0)

Session `Untitled-Untitled-20260926-042827-208`, 98 s, recorded with the J7 fixes. Website run
`a696b941`, status `succeeded`.

**JEM (the ruler):** ddagrab output 1 at 19.9 fps effective; AAC audio from the Yeti Nano, 98.17 s
against 98.25 s of video; drift **+17 ms** over 95 s (was -194 ms over 134 s). Monitor drag onto
and off the recorded monitor produced the right context spans (checked against video frames).
Edge workspace windows labelled correctly by URL. One new bug: the ddagrab probe ran after the
session clock started, giving a -1649 ms offset that the evaluator rejects. Fixed in JEM `090e025`.
No background-window scroll happened in this take, so `hover:` is still untested on real footage.

**JAMS against JEM (offset -1649 ms applied by hand):**

| Measure | Truth | Website | TP / FP / FN | Precision | Recall |
|---|---:|---:|---|---:|---:|
| Context switch | 6 | 7 (+2 on flashes) | 1 / 6 / 5 | 0.14 | 0.17 |
| Clicks | 14 | 84 | 9 / 75 / 5 | 0.11 | 0.64 |
| Scrolls | 13 | 0 | 0 / 0 / 13 | n/a | 0.00 |
| Keypresses | 8 | 0 | 0 / 0 / 8 | n/a | 0.00 |
| Transcript | 24 utterances | 24 | | | near-verbatim; one error ("Skrulls aren't anything") |
| Frustration flags (sentiment <= -0.5) | ~0 (the narration is upbeat) | **10 of 24** | | | |

Readings:

1. **Sentiment is the biggest customer-facing error.** The SST-2 model has no neutral class, so
   plain instructions score as strongly negative: "Testing one two three let's click on here"
   -0.99, "What if I drag and drop it there" -1.0, "All right, let's stop" -0.98. The Effort Score's
   sentiment component read 93 (very negative) on a session whose speaker said "I'm really happy
   to see how well it's working". Phase 4 item 7 moves up to first.
2. **Context-switch truth and video disagree in tiled layouts.** With four windows side by side,
   clicking between them changes focus but barely changes pixels, while dragging windows changes
   pixels a lot. 4 of 6 JEM switches here are focus changes between visible windows. This is the
   decision-5 definition question again; the visibility bands from the rescore apply.
3. **Scrolls: 0 of 13 again**, now at 19.9 fps, so capture rate was not the cause. The scrolled
   regions are single windows inside a tiled screen.
4. **Keypresses: 0 of 8** even with audio. The detector's audio gates did not fire on this
   keyboard/mic pair.
5. **Clicks: 84 detections for 14 clicks.** Known (weight 0).

## 4. What gets built

Eight components. Each has a single owner repo, and each is delegated per `CLAUDE.md`.

| # | Component | Repo | What it does |
|---|---|---|---|
| A | **JEM control channel** | jem | Named-pipe (or CLI) commands: `start {project, scenario, monitor}`, `pause`, `resume`, `stop-save`, `discard`, `now` (returns current active ms), `status`. The UI stays the same; the ViewModel commands become remotely callable. Removes the human from capture |
| B | **Journey runner** (`jem-drive`) | jem `tools/` | Executes a declarative journey script (app launch, click by UIA name or coordinates, type, wheel, key chords, waits) with SendInput. Queries `now` from JEM before each action and writes `intent.jsonl`: what it meant to do, when, and where. Replaces TestInjector's fixed choreography |
| C | **Narration track** | jams `worker/scripts` | Turns a journey's narration lines (text + declared sentiment + time) into local TTS audio (Windows SAPI or Piper ONNX, free and deterministic) and muxes it into the MP4 at scheduled offsets. Emits `narration.truth.json` (words, times, sentiment labels). This gives JEM sessions an audio ground truth without a microphone |
| D | **Evaluator v2** | jams `worker` | Extends `jem_eval.py` to every kind: context switch (visibility bands), clicks (time and x/y), keypress bursts, scroll count and distance, transcription WER, sentiment macro-F1 with neutral, segment boundaries, L2 rates per segment, L3 friction localization, L4 comparison direction. Input is a canonical measures export, so the same scorer reads local runs and website runs. Output: `scoreboard.json` + markdown |
| E | **Website runner** | jams `scripts` | Uploads a session's MP4 through the real web app with the E2E Clerk user (the sign-in-token path `pipeline-report.spec.ts` already uses), triggers analysis, polls, downloads `/api/analyses/:id/export`, and hands it to D. Targets the local stack for iteration and staging for release parity |
| F | **Friction fixture app** | jams `fixtures/jem-journeys` | Extends the existing local onboarding/checkout/recovery fixture with a `?variant=v1` (known friction: a misleading error, a hidden control, a dead-end step, a slow spinner) and `v2` (each fixed). Friction windows are declared in the journey script, so they are ground truth |
| G | **JEM witness check** | jem `tools/` | An independent low-level input logger (a separate process using Raw Input, no shared code with JEM's hooks) runs beside JEM. A checker compares three witnesses (runner intent, independent logger, JEM CSV) plus pixel checks (cursor position at each click, flash drift). Any event where JEM disagrees with the other two is a JEM bug |
| H | **MCP servers** | both | *JAMS MCP* inside `jams-web` (a route, not a new service; rule 5): `submit_recording`, `get_analysis`, `get_friction_moments` (with deep links), `get_measures`, `compare_runs`, `create_share_link`. It needs org-scoped API tokens through `withOrg`, which Claude designs (security-sensitive). *JEM MCP* (local stdio) wraps component A: `start`, `stop_save`, `status`. For us, an agent drives record, submit and score end to end. For customers, their coding agent pulls the friction moments, fixes the product, resubmits and compares: the customer loop, automated. Build it after E proves the API flow, before Phase 5 |

## 5. Phases

Each phase ends with a committed report and a measurable exit criterion. No phase needs Chris at
the keyboard unless it says so.

### Phase 0: clear the backlog and set the baseline (no new code except glue)

1. Score `Email Review` with today's evaluator (context switch only). **Done Sept 25**, see §3.3.
2. Stand up the local stack (`scripts/run-pipeline-e2e.ps1` pattern) and push every scorable
   session (Email Review, 181329, 133114, 133839) through the **website** by hand-scripting the
   upload with the E2E user. Export measures.
3. Compare website measures with the local harness for the same session: this is the first parity
   check (gap 1).
4. Hand-score the physical kinds for Email Review and 181329 with a throwaway script against the
   JEM CSV, to see how far off clicks, keys and scrolls really are on human footage.
5. Write `docs/ACCURACY-BASELINE-<date>.md`: one table per level, every number with its session and
   its sample size.

**Exit:** baseline scoreboard v0 exists, and every session on disk has a disposition.

### Phase 1: the measurement machine (components A, B, D, E)

Build the plumbing so one command runs *journey script → unattended JEM capture → narration mux →
website processing → scoreboard*.

**Exit:** `run-journey.ps1 browser-research-01` completes with no human input and produces a
scoreboard row; re-running it gives the same scores within tolerance (determinism check).

### Phase 2: validate the ruler (JEM developer persona; component G)

1. Witness runs: 20 scripted journeys covering clicks, typing (including modifiers and IME-free
   text), wheel and precision-touchpad scrolls, Alt+Tab, Win+number, Edge tab switch, Edge
   workspace, and an elevated window.
2. Stress runs: pause/resume storm, 15 min continuous, forced kill mid-session (reproduce the Sept 8
   crash), monitor with negative coordinates.
3. Capture-quality check: measure effective fps and frame-time jitter per backend and resolution.
   If 4K gdigrab stays at about 15 fps, record validation sessions at 1080p or finish ddagrab
   monitor mapping. A ruler that drops half its frames is not a ruler.

**Exit (JEM trusted for a kind only when all hold):** event counts agree 100% with the independent
witness for clicks, keypresses and wheel notches; JEM timestamps within ±20 ms of the witness;
sync drift ≤ 50 ms over 15 min; context spans agree with runner-declared window changes; crash
leaves a readable CSV and a recoverable video. JEM bugs found here are fixed in the jem repo before
Phase 3 uses the affected kind.

### Phase 3: build the corpus

1. Critique the 56 designed journeys against the visibility lesson: every transition gets a
   predicted band (invisible / near-noise / clearly visible) and the journey is revised so the
   clearly-visible band dominates, with a deliberate subtle stratum scored separately.
2. Pick about 20 journeys across the seven families. Freeze a **dev/holdout split grouped by journey
   family and app** before any capture, and commit it.
3. Capture them unattended (Phases 1 and 2 machinery), with synthetic narration.
4. **Human stratum (needs Chris, about 1 hour total):** 6 short journeys recorded by Chris at the
   keyboard, narrating aloud into a mic. AI-driven timing is not human effort and TTS carries no
   prosody, so these are the only sessions that test the product's real claim. They go entirely
   into holdout.

**Exit:** a frozen, versioned corpus manifest (`docs/journeys/corpus-v1.lock.json`) with the split,
visibility bands, and a checksum per session.

### Phase 4: hill-climb (JAMS developer persona)

Order is by leverage on the Effort Score and by how far each provider is from its gate:

| Order | Provider | Now | Target on holdout | First levers to try |
|---|---|---|---|---|
| 1 | Timestamps (L0) | p95 313 ms | p95 ≤ 250 ms, every session | Higher-fps capture; sub-frame cut refinement (peak of frame delta, not detector frame) |
| 2 | Context switch | F1 0.889 (visible, n=10) | F1 ≥ 0.95 on clearly-visible band; near-noise reported separately | Recall on faint-but-visible cuts without the IANA false positives; screen-region layout change features |
| 3 | Clicks | precision 0.045 (synthetic) | P and R ≥ 0.90 on clicks with a visible response | Cursor tracking (cursor is drawn in capture) + dwell + UI response near cursor; JEM x/y makes this a supervised problem |
| 4 | Scrolls | ~25% undercount ≤ 8 fps | count recall ≥ 0.90, distance within 12% | Capture fps fix first; then instant-jump detection |
| 5 | Keypresses | unmeasured on real footage | burst recall ≥ 0.90, count within 15% | Text-region growth, caret motion |
| 6 | Transcription | synthetic gates only | WER < 5% TTS, < 10% human | Model choice per run (`distil-small.en` vs `small.en`), RTF on target SKU |
| 7 | Sentiment | SST-2 is two-class | macro-F1 ≥ 0.85 over 3 classes; ≤ 10% of neutral lines flagged as frustration | A three-class ONNX model; SST-2 cannot say "neutral" |
| 8 | Segmentation | unmeasured | boundary F1 ≥ 0.85 at ±3 s | Journey scripts carry the segment truth |

Rules, carried over from the Sept 18 rescore and made mandatory:

- Tune only on dev. Holdout is scored once per candidate release, and only the release decision
  looks at it.
- Tolerances are frozen in `tolerances.json`. Changing one requires a written reason in the
  experiment ledger *before* the scores are seen.
- Every experiment gets a ledger row (`docs/accuracy/ledger.md`): hypothesis, change, dev before/after,
  decision. Negative results stay in.
- Report every metric by visibility band and by synthetic-vs-human stratum. Never pool the human
  holdout with synthetic sessions.
- Learned models trained on JEM data never see holdout journeys, not even other takes of them.
- **Graduation:** a weight-0 measure gets a default weight only after it passes its holdout gate
  on both the synthetic and human strata.

### Phase 5: the customer loop, end to end (customer persona; component F)

1. Record fixture `v1` (friction injected at declared times) and `v2` (fixed), three takes each,
   unattended, with narration that reacts to the friction (for example "why is this failing again").
2. Process through the website as a customer would. Open the report and the comparison page in the
   browser pane and check what a customer sees, not only the API.
3. Score:
   - **L3:** Highlights and the effort timeline localize each injected friction window (recall
     ≥ 95%) with ≤ 1 false friction flag per 10 minutes of clean journey.
   - **L4:** the comparison shows effort down in every fixed segment, unchanged (within noise) in
     untouched segments, and the right sign in 100% of v1/v2 pairs.
4. Repeat once on a real third-party site where Chris picks the "fix" (for example a better search
   query path), to test outside our own fixture.
5. Write the customer guide: how to record, how to read friction, how to re-record for a fair
   comparison (same task script, same monitor, same resolution).

**Exit:** L3 and L4 targets met on the holdout pairs.

### Phase 6: keep it true

- A nightly local job re-scores the whole corpus against `main` and diffs the scoreboard. A drop
  outside noise opens a spawned task.
- A small committed subset (short, redacted, deterministic) runs in CI as golden gates, next to the
  existing CV fixtures. No LLM calls, per the hard rule.
- Each JEM release re-runs the Phase 2 witness suite before its sessions enter the corpus.

## 6. Where Chris is needed (everything else runs unattended)

| When | What | Time |
|---|---|---|
| Now | Approve this plan and the decisions in §8 | 10 min |
| Phase 0 | Confirm the E2E Clerk user in `apps/web/.env.local` may be used for bulk uploads (local stack first; staging only for the parity run) | 2 min |
| Phase 2 | Allow computer-use control of JEM, Edge, Terminal and VS Code for unattended capture; keep the machine unused during capture windows | Scheduling only |
| Phase 3 | Record 6 narrated journeys (script provided, about 10 min each) | ~1 h |
| Phase 5 | Pick the real-site "fix" and sanity-check the customer-facing report | 20 min |
| Each release | Read the holdout scoreboard and approve graduation of any weight-0 measure | 10 min |

## 7. How the building gets done

Per `CLAUDE.md`: Claude writes specs and reviews; Copilot, then Codex, then OpenRouter models do
the typing, and every delegate logs to `docs/delegation-log.md`.

| Component | Spec written by | Built by | Why |
|---|---|---|---|
| A control channel, B runner, G witness | Claude (Win32/threading judgment) | Codex (surgical C#) with FlaUI tests; Claude subagent only if hooks threading stalls | JEM's own rules: hooks do zero work, UIA off-thread |
| C narration mux | Claude | Copilot | Scaffolding plus ffmpeg glue |
| D evaluator v2 | **Claude implements the metric definitions** (patent-core scoring and timestamp integrity); Codex does the tests and wiring | Mixed | Metric definitions are where silent inflation happens (see the Sept 18 recorder-process defect) |
| E website runner | Claude (touches auth) | Copilot | Clerk sign-in-token reuse, no new auth surface |
| F friction fixture | Claude writes the friction catalogue | Copilot | UI work |
| Phase 4 provider changes | Claude designs each algorithm change | Codex per change, aider/kimi-k3 for second opinions on hard detector ideas | Patent-core algorithms stay Claude-designed |

## 8. Decisions for Chris

1. **Capture resolution for the validation corpus.** Recommend 1080p on a dedicated monitor until
   JEM proves 30 fps at 4K. This conflicts with "record what customers record"; customers will
   upload 4K, so a 4K stratum stays in holdout once the ruler handles it.
2. **Synthetic narration is acceptable for dev, human narration only for holdout.** Recommend yes.
3. **Staging vs local for bulk processing.** Recommend local for iteration (free, fast,
   reproducible) and staging for one parity run per release, to keep preview quotas and Azure cost
   flat.
4. **Where raw sessions live.** Today they sit in `Documents/JEM`, outside Git, which is correct.
   Recommend a single `D:\jams-corpus\` root with the lock file in Git, so runs are reproducible
   after a reinstall.

5. **What counts as a context switch (patent definition).** Email Review shows the detector firing
   on in-app content changes (opening another email) that JEM does not log. Options: (a) only
   app/window switches count, and the detector must learn to ignore in-app changes; (b) both
   count as cognitive context changes, emitted as two measure kinds; (c) in-app changes count
   only above a size threshold (a new email counts, a hover tooltip does not). Recommend (b): it
   keeps the evidence, lets the score weight them separately, and needs no schema change beyond a
   new `kind` value in the canonical table.

## 9. Risks and honesty guardrails

- **Overfitting a tiny corpus.** The frozen split, the ledger and single-shot holdout scoring exist
  to stop it. Three sessions produced two misleading zeros; twenty will still be small.
- **AI-driven sessions are not human effort.** They validate detectors, not the Effort Score's
  meaning. The human stratum is the only evidence for the product claim and is reported alone.
- **TTS sentiment is lexical.** A model that passes on TTS can still fail on sighs, sarcasm and
  tone. Human-stratum sentiment is the gate.
- **Circularity.** Once detectors are trained on JEM data, JEM's systematic errors become JAMS's.
  Phase 2 witness checks are the defence, and they run again after every JEM change.
- **Proxy truth.** Foreground/title changes remain proxies for visual context. The visibility band
  decides whether a transition is testable at all.
- **Cost.** 4K decode is the slow step. Keep the evaluator on downscaled decodes, as it already is.
