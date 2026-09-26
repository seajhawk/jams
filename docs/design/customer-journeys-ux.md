# DESIGN: From recordings to answers, the customer's end-to-end experience

September 26, 2026. Status: **proposed.** Scope: information architecture, comparisons, and the
screens a customer moves through. Companion to `docs/ACCURACY-PROGRAM.md` (accuracy) and
`docs/PLAN.md` (architecture). Written by reviewing the product as it exists today
(`apps/web/src/db/schema.ts`, the page routes, `lib/compare.ts`) against the jobs a customer hires
JAMS for.

## 1. The customer's world

A customer does not think in recordings. They think in products and the jobs people use those
products to get done.

```
Workspace (org)
└── Project            a product or product area            "Azure App Service"
    └── Job            a job to be done (JTBD)              "Get my code running in the cloud"
        └── Journey    one way to get that job done         "Deploy from VS Code"
            └── Session one person doing that journey once   Alex, beginner, build 2026.09.2
                └── Analysis  JAMS's reading of the session (hidden unless it matters)
```

**Worked example (Azure App Service, the pattern Microsoft's docs are organized around).**

| Job | Journeys (different ways to get it done) |
|---|---|
| Get my code running in the cloud | Portal create + ZIP deploy · VS Code extension · `az webapp up` · GitHub Actions |
| Point my domain at the app | Portal custom domain + managed cert · CLI |
| Handle more traffic | Manual scale out · Autoscale rules |
| Find out why the app is failing | Log stream · Diagnose and solve problems · App Insights |

Each journey is worth measuring many times: by different people (a beginner and an expert), on
different builds (before and after a fix), and in different variants (A/B). The questions the
customer asks are almost always *comparisons*:

1. **Across journeys of one job:** which way of deploying is easiest? Least frustrating?
2. **Across people on one journey:** where do beginners struggle that experts do not?
3. **Across variants of one journey:** did variant B reduce effort, by how much, and how sure are we?
4. **Across time on one journey:** did the fix we shipped actually help? Is it getting worse?
5. **Across the portfolio:** which jobs are hardest, and where should the team spend next?

**Our own first customer is us.** JAMS has the same shape:

| Job (Project: JAMS) | Journeys |
|---|---|
| Get my first recording analyzed | Upload from Library · Upload from the empty state · (future) JEM direct upload · (future) API/MCP |
| Find where my product hurts | Read a report top-down · Jump through Highlights · Scrub the timeline |
| Prove a fix worked | Compare two recordings · (future) compare variants with stats |
| Share what I found | Share link · CSV/JSON export · (future) insight with clips |
| Tune what "effort" means for us | Weight profiles in Settings |

We record ourselves doing these with JEM, analyze them with JAMS, and hold every UX change to the
same before/after comparison we ask customers to trust (§7).

## 2. What the product does today, honestly

| Area | Today | Gap against §1 |
|---|---|---|
| Hierarchy | Org → **Task** (flat list) → Video → Runs | No project, no job, no distinction between a job and one way of doing it. A workspace with 3 products and 40 journeys becomes one flat list of 40 tasks. |
| People and variants | `subject_label`, `variant_label`: free text on a video | Not first-class: no cohort (beginner/expert), no build/version, no picking from a list, typos split groups, nothing aggregates by them. |
| Comparison | `/compare?runs=A,B`: exactly two runs, segment-aligned | The questions in §1 compare *groups* (5 beginners vs 5 experts; 8 sessions of A vs 8 of B). One session per side is an anecdote, and the UI does not say so. |
| Aggregation | None | A journey has no score of its own. There is no "median effort for Deploy from VS Code, n=12". |
| Where it hurts | Per-session Highlights | No cross-session view: "Step 3 caused frustration in 7 of 10 beginner sessions" is the single most valuable sentence JAMS could produce, and it cannot be produced today. |
| Steps | Segments are inferred per session (cues + scene cuts), optionally LLM-named | A journey has no declared steps, so sessions of the same journey cannot be lined up step by step reliably. |
| Comparability | Scores stored per run | **Nothing stops apples-to-oranges comparisons.** Today we changed the sentiment model and the negative threshold: a session's sentiment component went 93 → 45 → (expected) ~10 without the user changing anything. Comparing an old run with a new one silently mixes three scoring definitions. |
| Runs vs recordings | Runs surface in Library, detail, compare | "Run" is our implementation detail. Customers want "the analysis of this session", with re-analysis as an explicit, rare act. |
| Getting data in | One upload at a time through a dialog | A study produces 10–30 sessions at once. JEM already knows project and scenario; it should land in the right place without retyping. |

## 3. Proposed model

### 3.1 Entities

| Entity | Key fields | Notes |
|---|---|---|
| `projects` | name, description, icon/color | Replaces nothing; new top level inside a workspace. |
| `jobs` | project_id, name ("Get my code running in the cloud"), description, success criterion (optional, text) | The JTBD. |
| `journeys` | job_id, name ("Deploy from VS Code"), description, **steps** (ordered list of names, optional), status (active/retired) | Today's `tasks` become journeys (migration §3.3). Steps enable step-level alignment. |
| `participants` | pseudonymous label ("P07"), **cohort** tags (beginner, expert, admin…), notes | No names or emails by default: privacy by design, research-grade. |
| `variants` | journey_id or project_id scope, name ("A: current", "B: new wizard"), build/version string, date | Covers A/B, product versions, and "before/after fix". |
| `sessions` | journey_id, participant_id?, variant_id?, recorded_at, source (upload / JEM / API), device notes | Today's `videos`, renamed in the UI only (table rename optional). |
| analyses | unchanged `analysis_runs`, plus **scoring fingerprint** | See §3.2. |

Cohort and variant are separate on purpose: "beginner on variant B" is a normal question.

### 3.2 Comparability fingerprint

Every analysis records a fingerprint of everything that changes the numbers: provider ids and
versions (e.g. `sentiment 1.2.0 / roberta-3class`), weight profile id and version, score formula
version (bumped by changes like today's −0.15 → −0.3). Any aggregate or comparison checks that
all included analyses share a fingerprint. If not, the UI says so and offers one button:
**"Re-analyze N older sessions with the current definitions"** (quota-aware, runs in the
background). Numbers from different definitions are never averaged or subtracted silently.

### 3.3 Migration from today

- Each existing `task` becomes a journey under an auto-created job of the same name, inside a
  default project named after the workspace. Nothing is lost; users regroup later by drag and drop.
- `subject_label` values become participants (deduplicated case-insensitively); `variant_label`
  values become variants under the journey. Originals are kept in a backup column until confirmed.
- Existing runs get a fingerprint computed from their stored provider versions; old sentiment
  runs (`sentiment 1.0.0/1.1.0`) are marked comparable only with each other.

## 4. Comparisons that answer real questions

One compare builder, four modes. Each picks the grouping; JAMS does the rest.

| Mode | Groups | Headline the page leads with |
|---|---|---|
| **Journeys of a job** | one group per journey | "VS Code is the easiest way to deploy: median effort 31 vs 54 for Portal (n=9, 8)" |
| **Cohorts on a journey** | beginner vs expert (any cohort tags) | "Beginners spend 2.4× longer in *Configure settings*; 6 of 7 beginner sessions show frustration there" |
| **Variants of a journey** | A vs B (or before vs after) | "B reduced effort by 18 points (95% CI 9–27), mainly in *Choose a plan*" |
| **Over time** | one point per build/date | Trend with release markers and a flag when a build regresses |

Rules that make these trustworthy:

- **Distributions, not single numbers.** Show median and spread (strip plot of sessions, not a lone
  bar). Every group shows its n.
- **Honest confidence.** Differences get an interval (bootstrap over sessions). With fewer than
  ~5 sessions per group the headline says "Too few sessions to call this; record N more to know"
  instead of declaring a winner. This is the difference between insight and anecdote.
- **Step-level breakdown.** When the journey declares steps, sessions align step by step (segment
  → step matching, with manual correction on the session page). The breakdown shows where the
  difference comes from: effort, duration, frustration moments per step.
- **Evidence one click away.** Every number drills into the sessions and moments behind it, and a
  "show me" button plays the relevant clips back to back (the deep-link claim, used at scale).
- **Comparability guard** from §3.2 on every mode.

Two-session compare (today's page) stays as the drill-down "compare these two sessions side by
side", reachable from any group view.

## 5. Screens

1. **Workspace home.** Projects as cards: jobs count, sessions this month, hardest job, biggest
   recent change (up or down). Empty state walks through creating the first project with the JAMS
   example pre-filled as a template.
2. **Project page.** A jobs × journeys matrix: each cell shows median effort as a heat color, n, and
   a frustration indicator. The answer to "where should we spend next?" at a glance.
3. **Job page.** Journey leaderboard (easiest first) with distributions, a "compare journeys" entry,
   and the success criterion.
4. **Journey page.** The workhorse. Header: median effort, trend sparkline, n. Sections: step
   breakdown (if steps declared); **cross-session friction hotspots** ("*Configure settings*:
   frustration in 7/10 sessions, avg 42 s, [play all 7]"); session list with participant, cohort,
   variant, score, filters; quick compare by cohort or variant.
5. **Session report.** Today's report, plus breadcrumbs (Project › Job › Journey), participant /
   cohort / variant chips, step labels on the timeline, and "compare with another session".
6. **Compare builder.** Mode picker (§4), group pickers with counts, result page as described.
7. **Findings.** Save a comparison or hotspot as a finding with title, note, clips, and the numbers
   at that time (snapshot with fingerprint). Share link, export. This is what gets pasted into a
   planning doc.

Navigation: left rail with Projects (expandable to jobs and journeys), Compare, Findings,
Settings. Library stays as "All sessions" (a flat, filterable view for power users).

## 6. Getting data in without friction

- **Upload asks one question:** "Which journey is this?" with type-ahead across projects/jobs/
  journeys and inline create. Participant, cohort and variant are optional chips with
  autocomplete, remembered from the last upload.
- **Bulk upload:** drop 20 files; JAMS proposes assignments from file names and lets the user fix
  them in a table before anything uploads.
- **JEM direct:** JEM's project and scenario map to project and journey; JEM uploads the session
  (video + `session.json` metadata) through the API with a workspace token. The operator never
  retypes anything. (Also the path our own dogfooding uses.)
- **API / MCP** (plan component H): `submit_session(journey, participant?, variant?, file)`,
  `get_journey_summary`, `compare(mode, groups)`, `get_friction_hotspots(journey)`. A customer's
  coding agent can run the whole loop: pull hotspots, fix, resubmit, compare.
- **Processing delight:** one progress area for a batch ("12 of 20 analyzed"), a notification
  when a batch finishes, and the first hotspot shown as soon as enough sessions exist.

## 7. Dogfooding: measure JAMS with JEM and JAMS

1. Create project **JAMS** with the jobs and journeys in §1.
2. Baseline: record each journey with JEM, narrated, at least 3 sessions per journey (Chris for the
   human stratum; AI-driven runs for volume once the runner exists). Upload them to JAMS itself.
3. Every UX change in §8 ships with a before/after variant comparison on the affected journeys.
   Targets: effort median down, frustration moments down, time-to-first-insight down.
4. The first finding we expect to prove or disprove: *"Getting my first recording analyzed" takes
   too many steps and asks for labels the user does not have yet.*

This also exercises every accuracy-program level: if JAMS's own analysis of our sessions is wrong,
we feel it immediately.

## 8. Roadmap

| Phase | Ships | Why first |
|---|---|---|
| U1 | Projects → jobs → journeys (tasks migrated), participants with cohorts, variants; upload asks "which journey"; breadcrumbs; comparability fingerprint recorded on every analysis | Everything else hangs off the hierarchy; the fingerprint must start collecting now |
| U2 | Journey page with distributions and n; compare builder for cohorts and variants with confidence; comparability guard + bulk re-analyze | Answers questions 2 to 4 honestly |
| U3 | Declared steps, step alignment, cross-session friction hotspots with "play all" | The most valuable sentence JAMS can say |
| U4 | Workspace home, project matrix, job leaderboard; findings | Portfolio questions 1 and 5 |
| U5 | Bulk upload, JEM direct upload, API/MCP | Removes the per-file friction; enables agents |

Each phase: spec in `docs/specs/`, Playwright coverage for the new journey, and a dogfooding
before/after (§7).

## 9. Decisions needed

1. **Names in the UI.** "Job" is jargon to many customers. Options: *Goal* / *Task* / *Job*. And
   *Session* vs *Recording*. Recommend **Goal** and **Session**, with "job to be done" in help text.
2. **Participant privacy default.** Recommend pseudonymous labels only, with an opt-in to store
   names per workspace.
3. **Minimum n for a verdict.** Recommend 5 per group before any "winner" language, shown as
   guidance, never blocking.
4. **Re-analysis on definition changes.** Recommend never automatic (quota and cost), always offered
   with a count and one click.
5. **Library.** Keep as "All sessions", or fold into journey pages? Recommend keep for power users.
