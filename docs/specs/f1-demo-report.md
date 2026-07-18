# Spec F1-b: Interactive demo report page (contract-freezing)

Goal: build the complete interactive effort/sentiment report page against a hand-authored golden-fixture JSON, at route `/demo/report`. This page IS the product's payoff moment; the fixture's shape IS the frozen v1 contract that the future `GET /api/analyses/:id/report` endpoint and the Python pipeline must produce. Work on branch `f1-foundation` (after the scaffold spec f1-scaffold.md has landed). Read `docs/PLAN.md` §Data model first.

## 1. The frozen contract (most important part)

Create `apps/web/src/lib/report-contract.ts` — a **zod v4 schema** named `reportPayloadSchema` (+ exported TS types) for:

```jsonc
{
  "contract_version": 1,
  "run": { "id": "uuid", "video_id": "uuid", "status": "succeeded", // or "partial"
           "pipeline_version": "0.1.0", "finished_at": "ISO8601",
           "warnings": [ { "code": "no_audio", "message": "string" } ] }, // empty array when none
  "video": { "id": "uuid", "title": "string", "duration_ms": 850000,
             "width": 1920, "height": 1080, "has_audio": true,
             "playback_url": "string (absolute or root-relative)" },
  "task": { "id": "uuid", "name": "string" } , // nullable
  "segments": [ { "id": "uuid", "parent_segment_id": null, "name": "string",
                  "t_start_ms": 0, "t_end_ms": 212000,
                  "source": "audio_cue|scene_boundary|llm|manual" } ],
  "measures": [ { "id": "string", "kind": "context_switch|utterance|spoken_word|time_segment|sentiment",
                  "category": "physical|cognitive|time|sentiment",
                  "t_start_ms": 0, "t_end_ms": null, // null = point event
                  "value_num": null, "value_text": null, "unit": null,
                  "confidence": 0.92, "source": "video_analysis",
                  "provider_id": "string", "provider_version": "string",
                  "payload": {} } ],
  "score": { "profile": { "id": "uuid", "name": "Default",
                          "weights": { "context_switch": 3, "sentiment": 4, "spoken_word": 1, "time_segment": 2 },
                          "normalization": { "context_switch": "per_minute", "sentiment": "neg_density", "spoken_word": "per_minute", "time_segment": "raw_minutes" } },
             "components": { "physical": 22, "cognitive": 61, "time": 45, "sentiment": 58 }, // 0-100, higher = more effort
             "total": 52,
             "breakdown": [ { "kind": "context_switch", "raw": 24, "normalized": 63, "weight": 3, "contribution": 18.9 } ] }
}
```

Kind-specific payloads (validate with a discriminated union on `kind`):
- `utterance`: `{ text: string, words: [{ w: string, t0: number, t1: number }] }`, spans (t_end_ms set)
- `sentiment`: value_num ∈ [-1, 1], spans an utterance's timing
- `context_switch`: point event; payload `{ from: string, to: string }` (window/app labels), confidence set
- `spoken_word`: value_num = word count for the utterance span
- `time_segment`: mirrors a segment (value_num = duration_ms)

## 2. Score recompute (deterministic, parity-critical)

`apps/web/src/lib/effort-score.ts`: pure functions, no React.
- `normalize(measures, video, profile.normalization)` → per-kind normalized 0–100 values:
  - `per_minute`: count of that kind / duration minutes, scaled: `min(100, value * K)` with documented per-kind K chosen so the fixture lands at its stated normalized values
  - `neg_density`: share of narration time covered by sentiment measures with value_num < -0.15, scaled `min(100, share * 250)`
  - `raw_minutes`: `min(100, minutes * (100/30))` (30 min ⇒ 100)
- `score(normalized, weights)` → `{ components, total, breakdown }`; category components = weighted mean of the kinds mapped to that category (mapping per PLAN.md); `total` = weighted mean of all kinds: `Σ(normalizedₖ·wₖ)/Σwₖ`, rounded to integer; contributionₖ = `normalizedₖ·wₖ/Σwₖ`.
- Vitest: fixture + default weights reproduce the fixture's `score` block exactly; doubling one weight changes total per formula; zero-weight kind drops out.

## 3. The fixture

`fixtures/demo-report.v1.json` (repo root) — hand-author a *realistic, illustrative* ~14-min journey: "Deploy a Python web app to Azure" (task name), one participant narrating. Content requirements:
- 3 top-level segments ("Read the quickstart", "Configure and deploy", "Troubleshoot the failed deploy") + 2 sub-segments under the third
- ~24 context_switches clustered in the troubleshoot segment (docs ↔ terminal ↔ browser, from/to labels)
- ~40 utterances with believable think-aloud text and word timings; matching sentiment measures: mildly positive start, deepening frustration mid ("Why is it failing? The error says nothing…" ≈ −0.8) in the troubleshoot cluster, relieved/delighted ending ("Oh! Finally — it's live." ≈ +0.9)
- spoken_word measures per utterance; time_segment per segment; run.warnings = []
- `playback_url: "/demo.mp4"`. Add an npm script `demo:video` that copies `videos/SettingUpGoogleVideoAnalyzerForContextSwitches-ShotChange.mp4` → `apps/web/public/demo.mp4`, and gitignore `apps/web/public/demo.mp4`. Timings need not match that video's real content (illustrative demo).
- The fixture MUST parse with `reportPayloadSchema` — add a Vitest asserting it, and internal invariants: measures sorted by t_start_ms, all t within [0, duration_ms], sentiment/utterance spans have t_end_ms > t_start_ms.

## 4. The page (`/demo/report`)

Load the fixture (static import), validate with zod, render. Layout (desktop-first, responsive down to tablet):
- **Header bar:** task name + video title, run date, status chip, and the **Effort Score dial** (radial, 0–100, colored by band ≤33 green / ≤66 amber / >66 red) with the four component chips (Physical/Cognitive/Time/Sentiment). Tooltip on dial: "Lower is easier".
- **Player region:** Vidstack (`@vidstack/react`) playing `playback_url`, default layout, sticky while scrolling.
- **Timeline (the signature element)** directly under the player, full-width, custom SVG/Recharts hybrid, one shared ms→x scale:
  - Lane 1: segment bands (rounded rects, name labels, sub-segments as a thinner nested row); click band → seek to its start and pulse-highlight it
  - Lane 2: sentiment area chart interpolated from sentiment measures, gradient fill (positive teal-green → negative warm red), 0-line visible
  - Lane 3: context-switch dot markers (diamond glyphs; hover tooltip "from → to @ mm:ss")
  - Playhead line synced to player time (throttled ~4 Hz), draggable + click-anywhere-to-seek; current segment name shown above the playhead
- **Below, tabs (shadcn Tabs):**
  - **Transcript:** utterance list, each row mm:ss + text with a 3px left border colored by its sentiment; click row → seek; auto-scroll follows playback with a "resume auto-scroll" affordance after manual scroll
  - **Measures:** shadcn table of all measures, kind filter chips, columns time/kind/category/value/confidence; row click → seek
  - **Score:** breakdown horizontal bars (raw → normalized → weighted contribution per kind) + a slider per kind (0–10, default from profile) with **instant client-side recompute** of dial, chips, and bars via effort-score.ts; "Reset to profile" button
- **Polish bar:** keyboard shortcuts (space play/pause, ←/→ ±5s, s next segment start), skeleton loading states shaped like the layout, dark-mode compatible (Tailwind `dark:` — the scaffold's default theme), `sonner` toast "Demo report — upload your own video soon" on first load.
- A small "DEMO" badge in the header (this page later becomes the template for real runs).

## 5. Rules & acceptance

- New deps allowed: `@vidstack/react`, `zod`, `recharts` (and nothing else without noting why). No LLM calls anywhere.
- All timeline/transcript/score components live under `apps/web/src/components/report/` and take the parsed payload as props (no fixture imports inside components — the page does the loading) so real runs can reuse them unchanged.
- `pnpm build`, `pnpm lint`, `pnpm test` pass; Vitest covers effort-score math + fixture validation.
- Finish by printing: commits made, verification command results, and a list of any spec deviations.
