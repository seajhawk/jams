# CV provider fixtures

Browser-recorded videos and their ground truth for the scroll, click and hover-negative gates
in `worker/tests/test_fixtures_harness.py`. Recorded once with
`worker/scripts/make_cv_fixtures` and committed, because re-recording on every run let CI
runner load change the video (dropped frames mid-scroll moved the scroll gate from 9.0% to
6.4% on unchanged code).

To regenerate after changing a scenario:

```powershell
cd worker/scripts/make_cv_fixtures
pnpm install --ignore-workspace
pnpm fixtures --output-dir ../../../fixtures/cv
cd ../..
$env:JAMS_REGENERATE_CV_FIXTURES = "1"; uv run pytest tests/test_fixtures_harness.py
```

Record on an idle machine, check the gates still pass with the committed copy, and commit the
new files together with any change to the expected values.
