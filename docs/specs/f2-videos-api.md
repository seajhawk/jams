# Spec F2-a: tasks/videos schema + SAS-minting API

Goal: the data + API layer for the org-scoped video vault (docs/PLAN.md §Data model, §API surface, §Pipeline stage 1). Branch `f1-foundation` (F2 continues on it until PR). All routes go through the existing `withOrg` chokepoint (see `src/lib/with-org.ts` JSDoc example).

## Schema (Drizzle, `apps/web/src/db/schema.ts` + migration)

- `tasks`: id uuid PK default random, org_id text NOT NULL, name text NOT NULL, description text, created_at; UNIQUE(org_id, name); index (org_id).
- `videos`: id uuid PK default random, org_id text NOT NULL, task_id uuid FK→tasks nullable, title text NOT NULL, blob_path text NOT NULL, poster_blob_path text, size_bytes bigint, content_type text, duration_ms int, width int, height int, fps real, has_audio boolean, subject_label text, variant_label text, status text NOT NULL default 'uploading' CHECK in ('uploading','uploaded','failed'), uploaded_by text NOT NULL, created_at; indexes (org_id, created_at desc), (org_id, task_id).
- Migration must apply cleanly: `docker compose up -d postgres` + `pnpm db:migrate` (Docker is running).

## Blob lib (`apps/web/src/lib/blob.ts`)

`@azure/storage-blob` against `AZURE_STORAGE_CONNECTION_STRING` (Azurite locally; already in .env.example). Container `videos` (ensure-created lazily). Functions:
- `mintUploadSas(blobPath, contentType)` → { url, expiresAt } — write+create only, 15 min
- `mintReadSas(blobPath)` → { url, expiresAt } — read only, 60 min
- `blobStats(blobPath)` → { exists, sizeBytes, contentType } (server-side verify)
Blob paths: `{org_id}/{video_id}/original{ext}` and `{org_id}/{video_id}/poster.jpg` (container is already 'videos' — don't repeat it in the path).

## Routes (App Router handlers, all via withOrg, zod-validated bodies)

- `GET/POST /api/tasks` — list org tasks; create {name, description?} (409 on duplicate name)
- `POST /api/videos` — body {title, filename, content_type, size_bytes, task_id?, subject_label?, variant_label?}: validate content_type ∈ mp4|quicktime|webm|x-m4v, size ≤ 2 GiB; insert row status='uploading'; return {video_id, upload: mintUploadSas(original), poster_upload: mintUploadSas(poster.jpg, image/jpeg)}
- `POST /api/videos/[id]/complete` — body {duration_ms, width, height, has_audio, poster_uploaded: bool}: verify org owns row + blobStats(original).exists and size matches (else 409/400, status='failed' only on explicit {failed:true} body); set metadata + status='uploaded'
- `GET /api/videos?task_id=&status=` — org list, newest first, joined task name
- `GET /api/videos/[id]` — detail incl. task name
- `GET /api/videos/[id]/playback-sas` — {video: mintReadSas(original), poster: poster_blob_path ? mintReadSas(poster) : null}
- Errors: consistent {error} JSON; 401 via existing isUnauthorized pattern; 404 for cross-org ids (no existence leak).

## Tests + acceptance

- Vitest: route handlers with mocked withOrg/db (follow existing webhook test patterns); SAS lib unit-testable pure parts (path building, content-type/size validation). Integration vs Azurite optional — if trivial with docker running, add one round-trip test (mint SAS → PUT small blob via fetch → blobStats verifies).
- `pnpm build`, `pnpm lint`, `pnpm test` green; migration applied. Commit as logical chunks. Do not push. Do not touch UI pages.
- Finish: summary of files/commits/verification + append your row to docs/delegation-log.md (delegate=Codex, your model, grade, terse note) without rewriting that file.
