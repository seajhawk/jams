# U4: Findings, the project heat view, and the workspace summary

Design: `docs/design/customer-journeys-ux.md` §5 screens 1–3 and 7, §8 U4. Stacked on U3 (PR #15).
Branch `u4-findings-portfolio`. Never push `main`.

## Findings

A finding freezes an insight so it can be pasted into a planning doc and still mean the same thing
next month.

- Table `findings` (migration 0017): id, org_id, title, note, kind (`comparison` | `hotspot` |
  `leaderboard`), source (`{ journey_id?, goal_id?, by?, a?, b?, step_index? }`), snapshot jsonb (the
  numbers and verdict as shown, plus the reference fingerprint), created_by, created_at. RLS +
  grants like every tenant table.
- `POST /api/findings` (validated; the server recomputes the snapshot from `source` rather than
  trusting a client-sent one), `GET /api/findings`, `PATCH /api/findings/[id]` (title, note),
  `DELETE /api/findings/[id]`.
- "Save as finding" on the journey compare panel, on each hotspot row, and on the goal
  leaderboard. `/findings` lists them newest first with the frozen verdict, a "live now" link back
  to the source, and a warning when the live verdict no longer matches the snapshot.
- Public sharing of findings is **out of scope**: it needs a new unauthenticated route and gets its
  own security review.

## Portfolio views

- Project page: goals as rows, their journeys as heat cells (median effort color, n, frustration
  indicator from U3 hotspots when steps exist), so "where should we spend next?" is one glance.
- Projects page header: workspace summary cards per project: sessions in the last 30 days, the
  hardest goal (highest median of its easiest journey), and the most recent saved finding.

## Tests

- Unit: snapshot building and "verdict changed" detection.
- Integration: findings RLS isolation, server-side snapshot recomputation.
- Playwright: save a comparison as a finding, see it on /findings.

## Progress

- [x] Migration 0017 + findings API (+ Postgres integration test: server-side snapshot, workspace isolation, change detection; RLS catalog covers the table)
- [x] Save-as-finding buttons (compare panel, hotspot rows, goal leaderboard), /findings page with still-holds check, nav item
- [x] Project heat view and workspace summary
- [x] Playwright (`findings-u4.spec.ts`; all U-series specs pass locally together); web 331 tests, type check and lint clean; PR against `u3-steps-hotspots`
