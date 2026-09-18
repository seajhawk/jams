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

---

# Follow-up: is the IANA failure hillclimbable?

IANA was the one session whose truth events were both visually corroborated and both missed, so it
looked like the legitimate hillclimb target. Four experiments say the problem is harder and different
than "the content floor is too high".

## 1. Magnitude cannot separate true from false

Detector output over the full IANA video at descending adaptive content floors:

| floor | cuts found |
|---|---|
| 12.0 (default) | 600, 49800 — **both are sync flashes; zero real detections** |
| 8.0 | + 18400 (true), + 33400 (false) |
| 6.0 | + 43200 (false) |
| 4.0 and below | + 12000 (true) — saturates here |

The false positive at 33400 appears at a *higher* floor than the true event at 12000. Measured peak
visual delta confirms the overlap directly:

| t (ms) | what it is | peak delta |
|---:|---|---:|
| 12000 | true — JEM window to Edge | 1.13 |
| 18583 | true — page navigation | 1.89 |
| 33400 | false positive | 1.06 |
| 43200 | false positive | 1.25 |

A true event sits *between* the two false positives. No threshold on magnitude separates them.

## 2. The existing scroll filter cannot fire here

`translation_like()` requires phase-correlation response >= 0.25 **and** shift >= 2.5 px. Measured
shift at all four candidates is **0.01 to 0.03 px**. The filter is inert on this recording, not
mis-tuned.

## 3. There is no motion to detect, at any sample rate

Cropping away browser chrome and a 4x4 tile vote both return zero shift. Re-sampling the source at
30 fps in a +/-300 ms window around each candidate returns max |dy| of 0.02 to 0.05 px, with no
coherent run in any direction. Whatever happens at 33400 and 43200, it is not an animated scroll, so
no motion-based discriminator can help.

## 4. There is no scroll signature to find either

A direct vertical-offset overlap search (normalised cross-correlation across +/-90% of frame height)
finds no offset that improves on dy=0. The reason is the headline number: the frames 350 ms either
side of every candidate correlate at **0.994 to 0.996**. Before and after are all but identical.

## What this actually means

IANA's transitions are two renderings of the **same site template** — same header, same styling, same
white background, a similar block of text. The whole discrimination lives in about one grey level out
of 255, and the distractors live there too.

This corrects the earlier characterisation in this document. Calling IANA "a genuine detector failure"
was too generous to the test. It is a near-noise-floor discrimination task, and the corpus currently
has no way to tell "the detector is weak" apart from "this transition was nearly invisible".

The measured spectrum across every session on disk:

| band | peak delta | example |
|---|---|---|
| invisible | < 0.1 | Outlook foreground switch, 0.039 |
| near-noise | ~1 | IANA truths 1.13/1.89 — **and its false positives 1.06/1.25** |
| clearly visible | 2 to 12 | controlled fixture, where F1 is 0.889 |

## Consequences

1. **Visual corroboration should be graded, not a binary at 0.30.** A 1.1 event and an 11.7 event are
   not the same evidence. Report the band, and report detector performance per band.
2. **A journey only measures detector quality if its transitions sit in the clearly-visible band.**
   The corpus needs transitions in the 2-12 range to measure quality at all, plus a deliberately
   subtle stratum scored separately rather than pooled.
3. **Do not hillclimb on IANA.** Tuning to recover a 1.13 event while rejecting a 1.06 distractor is
   fitting noise on a sample of two, and it would drag the detector's operating point down to where
   every page wobble becomes a cut.
