# JEM → JAMS hillclimb results

This run exercised five customer journey classes with JEM: information finding on IANA, productivity search/filtering in Outlook, synthetic onboarding, synthetic checkout, and synthetic error recovery. The synthetic fixture is local and never sends data or creates an account, order, or payment.

The first real website recording (`00-browser-calibration/20260909-133114`) passed the CFR synchronization check with 29 ms end drift. JAMS context-switch detection scored precision 0.0, recall 0.0, and F1 0.0 against two customer-app foreground transitions. That is a valid failing baseline: the provider did not detect the transitions.

The native Outlook recording (`20260909-133839`) passed synchronization with 21 ms end drift and captured two Outlook clicks. It was recorded on the display where Outlook was visible; the earlier attempt on the primary display correctly produced no Outlook evidence. This establishes a recorder preflight requirement: the selected monitor must contain the customer app.

Browser-extension actions are excluded from ground truth. They can change a tab without producing the low-level desktop events JEM is intended to measure. Native desktop input through the Edge window produced the expected foreground and click records.

The JAMS harness now normalizes recordings to CFR before CV, requires both start and end flash anchors, rejects ambiguous bright-frame alignment, rejects unvalidated multi-segment pause alignment, and excludes recorder-only spans from customer-app metrics. It reports limitations rather than treating clicks, scrolls, sentiment, or automated timing as validated AI measures.

The JEM recorder fix keeps scroll spans tied to their origin process/window, splits spans across foreground changes, flushes idle spans without another wheel event, and attributes ledger counts to the originating context. The JEM solution passed 251 tests after that change. The JAMS synchronization tests pass 7/7 and Ruff reports no issues for the harness.

## Next hillclimb target

Tune the context-switch provider against the IANA and Outlook clips, then add a held-out screen-change clip. Do not loosen the ±250 ms synchronization gate or turn the failing F1 into a success by changing the truth window. The next release gate is a nonzero held-out F1 with timestamp error reported alongside precision and recall.
