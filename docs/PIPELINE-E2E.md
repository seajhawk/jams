# Local upload-to-report browser test

`apps/web/e2e/pipeline-report.spec.ts` exercises a real upload, local Blob storage,
queue dispatch, Python worker, report API/UI, and video seeking. It does not seed
analysis results or mock requests. The generated 12-second silent CFR video has
cuts at 4 and 8 seconds. Assertions require both cuts within 250 ms, an honest
partial/no-audio report, segmentation and scoring, and completed video seeking
within 250 ms of the selected measure.

On Windows, use PowerShell 7, PostgreSQL 16 binaries, Azurite 3.35.0, pnpm, and uv.
Install workspace dependencies and the matching browser first:

```powershell
pnpm install --frozen-lockfile
pnpm --dir apps/web exec playwright install chromium
./scripts/run-pipeline-e2e.ps1 `
  -PgBinDirectory D:/tools/pgsql/bin `
  -AzuriteEntryPoint D:/tools/azurite/node_modules/azurite/dist/src/azurite.js
```

Clerk development keys must be available in the process environment or the
existing ignored `apps/web/.env.local` / root `.env`. The setup reuses the dedicated
E2E user and organization in that development instance.

The runner requires unused loopback ports (defaults 55432, 11000–11002, 3100),
creates a new database cluster, applies the canonical Drizzle migrations, and
starts its own storage emulator and worker. The silent fixture needs no model
downloads or LLM calls. On completion or failure it stops its owned processes and
retains the isolated state directory and logs for diagnosis. Browser failure
traces may contain authentication or SAS data; keep them local. The test's JSON
evidence excludes playback URLs.

This is a deterministic pipeline smoke test. It does not establish detector
precision on customer recordings or replace the narrated-video evaluation suite.

## Narrated mode

Add `-Narrated` to the runner command to synthesize the known phrase
"synchronised speech for cross stage alignment check" with local espeak-ng,
starting at 4000 ms in the same 12-second video. This requires espeak-ng on PATH
and the worker's pinned Whisper and ONNX sentiment models already cached locally.
The runner sets `HF_HUB_OFFLINE=1`; it does not download models or call an LLM.

The narrated test requires full success with no warnings, real transcript/word
and ONNX sentiment measures, first-word timing within 250 ms of the known onset,
and both visual transitions. It verifies completed seeking from both a context
measure and the transcript, moving away from the transcript target first.
Both modes retain `playwright-report.json` in the isolated state directory;
the embedded `pipeline-report-evidence.json` attachment excludes playback SAS URLs.
The full Playwright report and failure traces remain local diagnostic material.
