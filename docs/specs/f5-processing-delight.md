# Spec F5: processing experience polish

Branch `f1-foundation` (push to origin when green; PR #1 open, do not merge). Read docs/PLAN.md §F5. Pure web slice — do NOT touch worker/ or the report components except as noted.

1. **`GET /api/analyses/[id]/measures?kind=&limit=`** (withOrg): thin route per PLAN §API surface returning measures for a run (works mid-run — the worker writes incrementally). Newest-first when `limit` given.
2. **"Found so far" teasers** on the processing panel (`AnalysisStatusPanel`): while status=running, poll the measures route alongside the existing status poll and show live tallies that tick up — context switches count, utterances transcribed (with the latest transcript line fading in), sentiment counts once present. Tasteful motion (CSS transitions, no heavy libs). Empty until first measures; never blocks the stepper.
3. **Duration-based ETA**: from video.duration_ms and stage weights (probe 10% / scenes 25% / transcription 45% / rest 20% — constants in one place), show "~2 min left" next to progress_pct; clamp optimism ("finishing up…" past 95%). Local benchmark says transcription RTF ≈ 0.14 — use 0.25 as the conservative planning factor, documented.
4. **Report-shaped skeletons**: the /reports/[runId] loading.tsx and the processing panel's terminal transition should preview the report's layout shape (dial circle, timeline bands, transcript rows) — reuse/extend the existing loading.tsx.
5. **Drive-by**: fix the Base UI warning from E2E logs — a component with `nativeButton` expected a native `<button>` on the video detail page (VideoDetailPage → Button render prop).
6. Tests: route unit test (org-scoped, kind filter); teaser component test with mocked polls (shows tallies, handles empty). `pnpm test/lint/build` + `pnpm test:e2e` green.
7. Email-when-done from PLAN §F5 is DEFERRED (needs an email provider — external service; Chris hasn't opted in). Note it in your summary as deferred, not skipped silently.

Finish: summary + scorecard row (✅/⚠️/❌). Leave user dirty files alone.
