# Spec F3-b1: category amendment + golden-fixture harness

Read `docs/design/f3b-patent-core-providers.md` FIRST — §0, §3, and the "Claude's review" section at the bottom are normative. Branch `f1-foundation`.

## Part A — `speech` category amendment (small, cross-cutting)

Per the review's Open Question 1 resolution: `utterance` measures are `category='speech'`.
1. apps/web: add `speech` to the category enum in `report-contract.ts`; change `KIND_CATEGORY.utterance` to `speech` in `effort-score.ts` (utterance is unweighted in default profiles, so component math is unaffected — but check tests); update the `utterance` rows in `fixtures/demo-report.v1.json`.
2. DB: if the `measures.category` column has a CHECK/enum constraint, migration to add `speech`; if free text, just update the schema comment.
3. All web tests/lint/build stay green.

## Part B — fixture harness (design §3, fixtures ONLY — providers come in the next slices)

4. `worker/scripts/make_fixtures.py` — deterministic generation (static-ffmpeg) of the design's synthetic set into `worker/tests/fixtures/generated/` (gitignored; generated on demand + in CI): synth_switches, synth_scroll (with the planted mid-scroll cut), synth_drag, synth_idle (blink), the A/V-sync fixture (spoken word + hard cut at same offset), silence + tone-"music" wavs, and the planted-offset speech wav. TTS: use espeak-ng ONLY if on PATH; otherwise skip TTS-dependent fixtures with a clear registry marker (do not fail generation). Ground-truth metadata for every fixture written alongside as JSON (cut times, transcript text, offsets) — computed from the SAME constants that drive generation, no duplication.
5. `worker/tests/golden.py` — reusable assertion helpers per design §3b: greedy chronological one-to-one cut matching (±tolerance, precision/recall/F1), WER via pinned jiwer with the design's normalization (fixture scripts avoid digits), word-timestamp invariants I1–I3, and the I4 cross-stage ±250ms check. Pure functions, unit-tested against hand-built cases.
6. Harness self-consistency tests (green NOW, without providers): generate fixtures, then ffprobe each and assert the media matches its ground-truth JSON (duration, cut-boundary frame deltas present at declared times via a simple frame-diff probe, audio offsets). Run generation twice → assert ground-truth JSONs identical (determinism).
7. Real-clip fixtures: register `videos/Sample_Amazed then Frustrated.m4a` and the 2023 mp4 in the fixture registry as `real/*` entries with `transcript: PENDING_HUMAN` markers — harness skips WER on them until transcripts are added (note for Chris in summary).

## Acceptance

- `uv run pytest` (incl. new harness tests) + `uv run ruff check` green; `pnpm test/lint/build` green after Part A; fixture generation < ~3 min.
- Do not touch provider code beyond what exists; do not push; leave user dirty files alone. Logical commits.
- Finish: summary + numbered list of skipped/TTS-pending fixtures + append your scorecard row (delegate=Copilot, model, grade, note).
