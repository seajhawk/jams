# Spec F2-b: Upload flow + video library + playback UI

Goal: the delightful front half of the video vault (docs/PLAN.md §Pipeline stage 1, §Feature roadmap F2). Branch `f1-foundation`. Prereq: f2-videos-api.md routes exist — read those route files first and match their contracts exactly. Reuse shadcn components and the app shell; polish bar per AGENTS.md (skeletons, honest errors, teaching empty states).

## Upload flow (`src/components/upload/`, dialog or dedicated surface off Library)

1. Drag-drop zone + file picker (accept mp4/mov/webm/m4v). On file select, BEFORE any network: hidden `<video>` + canvas extract duration_ms/width/height/has_audio + poster JPEG (~0.8 quality, first non-black frame or t=1s). Reject >20 min or >2 GiB with friendly copy.
2. Form alongside preview poster: title (prefilled from filename), task combobox (existing tasks + "create new" inline via POST /api/tasks), optional subject_label / variant_label inputs with one-line hints ("Who performed it?" / "Approach or product being compared").
3. POST /api/videos → upload poster via its SAS (plain PUT, `x-ms-blob-type: BlockBlob`), then video via `@azure/storage-blob` BlockBlobClient.uploadData(file, {blockSize: 4 MiB, concurrency: 4, onProgress}) — real progress bar with MB/s + ETA, cancel button (AbortController) that also POSTs complete {failed:true}.
4. On success POST /api/videos/[id]/complete with the local metadata → toast + navigate to library with the new card highlighted.

## Library (`/library` — replace the empty-state placeholder in the shell)

- Responsive card grid: poster thumbnail (playback-sas poster URL, skeleton while loading), title, duration badge (format-ms), status badge (uploading=pulsing amber/uploaded=green/failed=red with retry-upload affordance), task name chip, subject/variant chips when set.
- Filters: task select + status; empty states: no videos at all → teaching hero with upload CTA + link to /demo/report sample card (keep existing sample card); no matches → "clear filters".
- "Analyze" button on each uploaded card: disabled with tooltip "Analysis arrives in the next update".

## Playback (`/library/[id]`)

- Reuse the existing report VideoPlayer component (Vidstack) with the playback SAS URL; metadata sidebar (all fields, task link, uploaded-by/when); Back to library. 404 page for unknown/cross-org id.

## Acceptance

- `pnpm build`, `pnpm lint`, `pnpm test` green (add component tests only where cheap — e.g., the local metadata extractor with a mocked video element; don't force jsdom video decoding).
- Manual-checkable flow documented in your summary: with docker azurite + postgres up and `pnpm dev`, a real .mp4 uploads with visible progress, lands in the grid with poster + duration, and plays on its detail page.
- Commits in logical chunks; do not push; don't touch worker/ or the report page.
- Finish: summary of files/commits/verification + append your row to docs/delegation-log.md (delegate=Copilot, your model, grade, terse note) without rewriting that file.
