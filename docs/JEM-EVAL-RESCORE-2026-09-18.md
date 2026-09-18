# JEM evaluator correction and re-score — September 18, 2026

Two defects were found in `worker/src/jams_worker/jem_eval.py` and fixed, and every JEM session on
this machine was re-scored. The headline metric definition is unchanged, so every number below is
directly comparable to `JEM-HILLCLIMB-2026-09-09.md`. The stratified numbers are added alongside,
never substituted.

## What changed

**1. Recorder identification is no longer a hardcoded process name.** The truth filter compared
`process` against the literal `"jem.app.exe"`. The recorder is now identified by which context span
was foreground during a manifest sync flash, so it survives a rename or a headless harness.

This mattered urgently: the proposed orchestration for unattended capture runs the flash presenter
from a differently-named process. The literal filter would not have followed, and both flash spans
would have become *truth events* sitting exactly on a full-screen white-to-content transition — the
most detectable visual event that exists. That is two free true positives per journey on a metric
where a short journey has about six. It would have inflated every future score silently.

**2. Every truth event now carries the measured visual change at that instant.** JEM logs a context
switch on a foreground or title change. That is a proxy for visual change and can diverge from it
completely. The evaluator now decodes a downscaled grayscale delta profile and records, for each
truth event, the peak frame-to-frame delta within the match tolerance.

Events are reported in three groups — all truth (unchanged, baseline-comparable), visually
corroborated, and proxy-only — and the per-event delta is emitted so the split can be audited or
re-cut without re-running anything.

## Re-score, old vs new

Detector defaults unchanged. `MATCH_TOLERANCE_MS` unchanged at 500.

| Session | Content | Old F1 | New F1 (all truth) | Truth events visible | Verdict |
|---|---|---:|---:|---|---|
| `20260909-133114` | IANA, real website | 0.0000 | **0.0000** | **2 of 2** (delta 1.13, 1.89) | **Genuine detector failure** |
| `20260909-133839` | Outlook, native app | 0.0000 | **0.0000** | **0 of 1** (delta 0.04) | **Not a valid test** |
| `20260909-181329` | Controlled fixture | 0.8889 | **0.8889** | **10 of 10** (0.46 – 11.66) | Genuine; 2 misses are the faintest |

Of eleven sessions on disk, three are scorable. Four are metrics-only with no video, two exceed the
20-minute probe limit, and two are recorder-only.

## The finding that matters

**The Outlook session cannot produce a meaningful score for a video analyser.** Its single truth
event is JEM's foreground switch into an Outlook window that was already filling the captured
monitor. The measured screen change at that instant is **0.039**, against a video whose 95th
percentile is 0.02 and whose sync flashes measure ~180. Genuine transitions in the other sessions
measure 1.13 to 11.66.

JAMS was scored 0/0/1, F1 0.0000, for failing to detect something invisible in the recording it was
given. Lowering the adaptive content floor to 2.0 does not recover it either, because there is
nothing there to recover — the detector's only cuts in that whole recording are at 400 ms and
47600 ms, which are the two sync flashes.

This is one of the two real-world zeros that has been driving strategy. It is not evidence about the
detector. `EVALUATION-MATRIX.md` already warned that foreground and title spans are proxy labels;
this quantifies how far the proxy can diverge.

**IANA is the opposite and remains a real failure.** Both of its truth events are genuinely visible
(1.13 and 1.89) and both were missed at the default floor. That is legitimate hillclimb territory,
and the `min_content_val=4` variant already recovers both at the cost of two false positives.

## Caveats

- **The corroboration threshold has thin margin.** It is set at 0.30. The weakest genuine transition
  measured anywhere is the controlled fixture's checkout receipt at **0.456** — a factor of 1.5. A
  threshold of 0.5 would have misclassified a real transition as proxy-only. This is exactly why the
  per-event delta is emitted rather than only the verdict.
- **Three scorable sessions is not a basis for any claim.** These are diagnostic samples.
- The controlled fixture's matched-event timing error is mean 178.5 ms, p95 312.7 ms, max 319 ms,
  which still does not clear the 250 ms cross-stage gate.
- The threshold was chosen after looking at measured deltas. That is disclosed deliberately: it is a
  reporting stratification, it does not alter the headline metric, and no tolerance was loosened.

## What this changes

1. A journey only tests the context-switch detector if its transitions are **visually real**. Corpus
   design must verify this per journey rather than assume a foreground switch implies a visible one.
2. Recall should be reported against visually corroborated truth. Proxy-only events are reported
   separately and never silently counted as detector misses.
3. The 95% target applies to corroborated events. Scoring against proxy-only events would train the
   detector to invent cuts where no pixels changed, which makes JAMS worse, not better.
