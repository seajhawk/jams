# Upload-to-report verification — September 11, 2026

The real local customer flow now passes in Chromium: Clerk sign-in, browser upload
to Blob storage, analysis queue dispatch, Python processing, report rendering, and
clicking a measure to seek the video. No analyses or measures were seeded, and no
API routes were mocked. See [PIPELINE-E2E.md](PIPELINE-E2E.md) for the runner.

The passing test took 21.8 seconds (26.5 seconds including Playwright setup).
The isolated database confirmed `partial/no_audio`, context switches at exactly
4000 and 8000 ms, and a persisted Effort Score of 30. The browser checked completed
seeking (`!seeking`, frame data available) within 250 ms of the selected event.
The video is a generated 12-second silent 30 fps fixture; these timings are not a
performance claim for customer recordings.

Four product defects discovered and fixed:

- Upload highlight expiry could cancel navigation to a video. The timer now
  changes only visual state.
- A first analysis could run before the organization webhook created a scoring
  profile. Analysis creation now provisions it in the same scoped transaction
  before dispatch.
- Silent recordings could finish as fully successful. Missing narration now
  produces a partial result and a persisted `no_audio` warning; other processing
  problems retain precedence.
- Report assembly discarded detected transitions without application labels.
  Unknown labels are now nullable, timestamps remain present, and the timeline
  uses a neutral label instead of inventing application identities.

Verification: 138 web tests passed against PostgreSQL; production build and
TypeScript passed. The 25 focused pipeline/repository/lease tests and worker Ruff
passed. Astra reviewed the runner, navigation, profile bootstrap, worker status,
and report contract fixes with no remaining actionable findings after revisions.
Luna implemented the browser spec and web regressions and drafted the worker fix;
the primary completed integration and runtime verification.

The full local worker suite had 157 passes, 8 skips, and one known failure:
the narrated-click audio proposal precision gate remains 6 TP / 126 FP / 0 FN
(precision 0.04545 versus 0.85 required, before visual verification). Its threshold
is unchanged. This is still a release-quality gap for that experimental detector.

Next: extend the real flow to narrated recordings and failure/retry paths, then
continue the detector improvement loop on customer-like recordings with precision,
recall, timing error, and false positives during scrolling and idle periods.
Azure deployment and customer invitations remain deferred.
