# U2: Group comparisons with honest confidence, and fixing mixed scoring definitions

Design: `docs/design/customer-journeys-ux.md` §4 and §8 (U2). Builds on U1 (PR #13). Branch:
`u2-group-comparisons`, stacked on `u1-hierarchy`. Never push `main` from this work.

## Questions it answers

1. **Variants of a journey:** did B reduce effort compared with A, by how much, how sure are we?
2. **Cohorts on a journey:** do beginners spend more effort than experts?
3. **Journeys of a goal:** which way of reaching this goal is easiest?

## Statistics (`lib/stats.ts`, client-safe, deterministic)

- Group summary: n, median, p25, p75 (existing `summarizeTotals`).
- Difference of medians (B minus A) with a **95% percentile bootstrap interval**: 2,000 resamples,
  seeded PRNG (mulberry32, seed fixed) so the same data always gives the same interval.
- Verdict, in plain words, with n always shown:
  - either group under 5 scored sessions → "Too few sessions to call this. Record at least N more
    in <group>."
  - interval excludes 0 → "<B> takes less/more effort than <A>: median X lower/higher (95% range
    L to H)."
  - otherwise → "No clear difference yet (the 95% range L to H includes zero)."
- **Comparability:** only sessions scored with the same definition are compared. The reference
  fingerprint is the one used by the newest analysis in the compared set; sessions with other
  fingerprints are excluded and counted ("3 sessions excluded: scored with older definitions").

## API

- `GET /api/journeys/[id]/compare?by=variant|cohort&a=<name>&b=<name>`: both groups' stats, the
  difference and interval, verdict, reference fingerprint, excluded count.
- `GET /api/goals/[id]/compare`: each journey of the goal with stats on the reference fingerprint,
  ranked easiest first, each non-best journey's difference from the best with interval, verdict.
- `POST /api/journeys/[id]/reanalyze` `{ "only": "outdated" }`: queues a new analysis for every
  session whose latest analysis does not use the reference fingerprint (or has none), through the
  same admission and dispatch path as `POST /api/analyses` (quota-aware). Returns counts queued and
  skipped with reasons. Never automatic; the UI asks first.

## UI

- Journey page: a **Compare** panel with a By variant / By cohort switch and two group pickers,
  showing both strip plots side by side, the verdict sentence, and the numbers. The
  mixed-definitions warning gains a **Re-analyze N sessions** button (confirm dialog with the count
  and the quota note).
- Goal page `/goals/[id]`: journeys of the goal as a leaderboard (easiest first) with distribution,
  n, difference from the easiest and verdict. Goals in the catalog link to it; breadcrumbs link to
  it.

## Tests

- Unit: bootstrap determinism (same input → same interval), interval brackets the true difference
  on a clear-cut case, verdict thresholds and wording, fingerprint filtering.
- Integration (Postgres): compare API over seeded variants and cohorts, exclusion counting,
  reanalyze queues only outdated sessions and respects admission.
- Playwright: journey compare panel renders a verdict for seeded data; goal leaderboard orders
  journeys.

## Progress

- [x] Stats: bootstrap interval, verdict, fingerprint filtering (+ unit tests)
- [x] API: journey compare, goal compare, reanalyze (+ unit tests of the comparison logic and a Postgres integration test of the shared queue helper)
- [x] UI: journey compare panel, re-analyze button, goal page and links
- [x] Playwright (`comparisons-u2.spec.ts` passes locally); web 317 tests, type check and lint clean; PR opened against `u1-hierarchy` (not merged)
