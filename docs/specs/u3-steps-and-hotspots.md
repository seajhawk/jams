# U3: Declared steps, step alignment, and cross-session friction hotspots

Design: `docs/design/customer-journeys-ux.md` §4 (step-level breakdown), §5 (journey page
hotspots), §8 U3. Builds on U2 (PR #14, stacked on U1 #13). Branch `u3-steps-hotspots`, stacked on
`u2-group-comparisons`. Never push `main`.

The sentence this exists to produce: **"Configure settings: frustration in 7 of 10 beginner
sessions, 42 s on average. [Play all 7]"**

## Declared steps

A journey's `steps` (U1 column) is an ordered list of names. Editable on the journey page (add,
rename, reorder, remove) through `PATCH /api/tasks/[id]`.

## Step alignment (Claude-designed; pure, deterministic, in `lib/steps.ts`)

Input: the journey's steps `S[0..m)`, one session's analysis segments `G[0..k)` in time order
(name, t_start_ms, t_end_ms; top-level only, `parent_segment_id` null), the session duration, and
optional manual boundaries. Output: for each step, `{ t_start_ms, t_end_ms, source }` covering the
session without gaps, in step order, where `source` is `manual`, `matched` or `even`.

1. **Manual wins.** If the session has stored boundaries (`videos.step_boundaries_ms`, a jsonb array
   of m−1 ascending cut times), use them. `source = "manual"`.
2. **Matched.** Otherwise, if k ≥ m, choose m−1 cut points among the k−1 segment boundaries so each
   step is a run of consecutive segments. Each segment votes for the step whose name it resembles
   (similarity = Jaccard overlap of lowercased word stems: letters only, words of 3+ letters, a
   small stop list dropped, then strip a plural "s", then "ing" or "ed", then a trailing "e"); the
   partition maximizes the sum of votes. (Scoring each step against its whole run instead was
   tried and rejected: it lets a step swallow an unrelated neighbouring segment.) Dynamic
   programming over (step, segment), O(m·k²). Accept only if every step receives at least one
   positive vote; `source = "matched"`.
3. **Even.** Otherwise split the session duration into m equal spans. `source = "even"`. The UI says
   so ("Steps estimated by time; set them on the session to be exact").

`POST /api/videos/[id]/step-boundaries` `{ boundaries_ms: number[] }` stores manual boundaries
(validated: m−1 values, strictly increasing, inside (0, duration)); `DELETE` clears them.

## Friction hotspots (pure, in `lib/hotspots.ts`)

For each step and each session on the reference scoring definition (U2 rule), from that session's
latest analysis measures:

- `frustrated` = any `sentiment` measure with `value_num <= FRUSTRATED_THRESHOLD` (−0.5, from
  `report-moments.ts`) whose start falls in the step's span. The worst such moment (lowest value)
  is the step's **evidence moment** for that session.
- `duration_ms` = step span length. `switches` = count of `context_switch` measures in the span.

Per step: `frustrated_sessions`, `sessions`, mean duration, mean switches, and the evidence moments
(video_id, run_id, t_ms, utterance text if linked). Hotspots are steps ranked by
`frustrated_sessions / sessions`, then mean duration. Filterable by cohort and variant like the
rest of the journey page.

## API

- `GET /api/journeys/[id]/steps?cohort=&variant=`: steps, per-session alignment (with source), and
  the per-step aggregates above.
- `POST/DELETE /api/videos/[id]/step-boundaries` as above.

## UI

- Journey page: **Steps** section. If no steps: a prompt to declare them (with the session's
  segment names as suggestions). Else a table: step, frustration (k of n, bar), mean time, mean
  switches, **Play all** (when k > 0). Estimated-steps note when any session used `even`.
- **Play all**: an in-page player that plays each evidence moment back to back from 1.5 s before
  to 6 s after it (playback SAS per session), with the session title, participant and the words
  said, and next/previous.
- Report page accepts `?t=<ms>` and seeks there on load (for "open in report" from a clip).
- Session page: "Steps" editor placing the m−1 boundaries on the timeline (default from the current
  alignment), save and reset.

## Tests

- Unit: alignment (manual precedence; matched on a clear case; rejects a partial match and falls
  back to even; ties are deterministic; k < m falls back to even), hotspot aggregation and ranking,
  boundary validation.
- Integration: steps API over seeded segments and measures, cross-org isolation.
- Playwright: declare steps, see the hotspot row and "Play all" for seeded frustrated sessions;
  report `?t=` seeks.

## Progress

- [x] Alignment + hotspot core (`lib/steps.ts`, `lib/hotspots.ts`) with unit tests
- [ ] Migration 0016 (`videos.step_boundaries_ms`), steps API, boundaries API (+ tests)
- [ ] UI: steps editor, hotspot table, Play all, report `?t=`, session boundary editor
- [ ] Playwright; suites green; PR against `u2-group-comparisons`
