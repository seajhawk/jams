# JEM → JAMS hillclimb results

Five candidate customer journey classes were selected: information finding, productivity, onboarding, checkout, and error recovery. The September 9 baseline completed information finding on IANA and productivity search/filtering in Outlook. Synthetic onboarding was exercised but its recording ran unattended after interruption and is excluded. Checkout and recovery fixtures were prepared but were not completed in that baseline. The synthetic fixture is local and never sends data or creates an account, order, or payment.

Correction to the earlier chat summary: IANA's validated F1 is 0.0. The reported 0.3333 belonged to the invalid recorder-only calibration before the synchronization fixes and must not be used as evidence. Outlook logged two clicks but only one customer-app foreground span; clicks are not context transitions.

The first real website recording (`00-browser-calibration/20260909-133114`) passed the CFR synchronization check with 29 ms end drift. JAMS context-switch detection scored precision 0.0, recall 0.0, and F1 0.0 against two customer-app foreground transitions. That is a valid failing baseline: the provider did not detect the transitions.

The native Outlook recording (`20260909-133839`) passed synchronization with 21 ms end drift and captured two Outlook clicks. It was recorded on the display where Outlook was visible; the earlier attempt on the primary display correctly produced no Outlook evidence. This establishes a recorder preflight requirement: the selected monitor must contain the customer app.

Browser-extension actions are excluded from ground truth. They can change a tab without producing the low-level desktop events JEM is intended to measure. Native desktop input through the Edge window produced the expected foreground and click records.

The JAMS harness now normalizes recordings to CFR before CV, requires both start and end flash anchors, rejects ambiguous bright-frame alignment, rejects unvalidated multi-segment pause alignment, and excludes recorder-only spans from customer-app metrics. It reports limitations rather than treating clicks, scrolls, sentiment, or automated timing as validated AI measures.

The JEM recorder fix keeps scroll spans tied to their origin process/window, splits spans across foreground changes, flushes idle spans without another wheel event, and attributes ledger counts to the originating context. The JEM solution passed 251 tests after that change. The JAMS synchronization tests pass 7/7 and Ruff reports no issues for the harness.

## Completed follow-up: controlled journeys

Session `00-browser-calibration/20260909-181329` completed all three local fixture flows using native Edge input and was saved immediately afterward. JEM was verified Idle and its temporary HTTP server stopped. The 92.3-second video was visually inspected at the simulated receipt; nine fixture clicks and the expected title transitions are present in CSV. Original recordings remain local under Documents/JEM, outside Git.

Default adaptive detector, no tuning: start offset −12 ms, end drift +5 ms, 8 true positives, 0 false positives, 2 false negatives; precision 1.0, recall 0.8, F1 0.8889. Mean absolute matched-event error is 178.5 ms at the specified 500 ms event-matching tolerance. End-flash drift and detector timestamp error are different measurements: individual matched detector errors exceed 250 ms, so this does not establish the production cross-stage timestamp gate.

| Candidate journey class | Evidence | TP / FP / FN | F1 |
|---|---|---|---|
| Information finding | IANA real website, `133114` | 0 / 0 / 2 | 0.0000 |
| Productivity | Outlook native filters, `133839` | 0 / 0 / 1 | 0.0000 |
| Onboarding | Controlled fixture, video 14–31 s | 3 / 0 / 0 | 1.0000 |
| Checkout | Controlled fixture, video 35–60 s | 3 / 0 / 1 | 0.8571 |
| Error recovery | Controlled fixture, video 63–81 s | 1 / 0 / 1 | 0.6667 |

The three fixture windows were selected from the observed workflow and CSV title transitions. Combined metrics also include the initial browser-foreground transition. Misses occur at the checkout receipt (expected 51925 ms) and recovered-upload page (expected 73131 ms). These are diagnostic samples, not market validation or a representative customer benchmark. JAMS upload, database processing, and report rendering have not been exercised by this local provider harness.

An exploratory IANA threshold trial found the page transitions at min_content_val=4, but also mislabeled the scroll around 33.4 s. Defaults remain unchanged. This trial used the provider's 5-fps proxy directly and is diagnostic only; published baseline metrics above use the validated CFR harness.

Luna's subagent could not access native Windows control (`Trusted RPC service is not configured`), while native control in the main task worked. The main task therefore completed these recordings. Luna continued with a bounded regression-test assignment. This is an agent-session capability limitation, not evidence of a JEM failure.

The point matcher was also corrected: nearest-first pairing could consume the only detection available to a later event. Ordered one-to-one matching now preserves the maximum number of matches; regression coverage checks that detections cannot be reused.

## Next hillclimb target

Diagnose the receipt/recovery misses and scroll false positive, then evaluate any provider change on held-out recordings. Keep foreground/title transitions explicitly labeled as proxy ground truth: a foreground event can occur without a visual change. Do not loosen synchronization or matching tolerances to improve scores. Main checkout still has an unfinished media-timebase merge; this work is isolated on `codex/jem-validation` until integration is safe.
