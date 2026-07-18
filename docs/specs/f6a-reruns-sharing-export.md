# Spec F6-a: re-run history, share links, export

Branch `f1-foundation`; push when green (PR #1 open, do not merge). Read docs/PLAN.md §F6. Web-only slice.

## Re-run versioning (schema exists — superseded_by chain from F3-a)

1. Video detail: run history list (date, pipeline_version, status, total score when scored); "Re-analyze" button POSTs /api/analyses (existing chain semantics). Report page: banner when viewing a superseded run ("A newer analysis exists → view") and when a newer run is processing.

## Share links (SECURITY-SENSITIVE — follow exactly)

2. Migration + Drizzle: `share_links` per PLAN §Data model — id uuid PK, run_id FK, org_id, token text UNIQUE, expires_at, created_by, created_at, revoked_at nullable.
3. Token: 32 bytes from crypto.randomBytes, base64url. Generated server-side only.
4. `POST /api/analyses/[id]/share` (withOrg): create link with expiry option {1,7,30} days (default 7). `GET` lists links for the run; `DELETE /api/share-links/[id]` sets revoked_at. Never return tokens in list responses after creation (show token once at create; list shows created/expiry/revoked + last4 only).
5. Public page `/share/[token]`: EXEMPT from Clerk middleware (narrow path match). Lookup by unique token where revoked_at is null and expires_at > now(); anything else → generic 404 (identical response for invalid/expired/revoked — no oracle). Renders ReportShell with a NEW optional `readOnly` prop: hides "Save as org default", hides app chrome (standalone layout with a minimal JAMS header + "Shared report" badge), weight sliders still work client-side (session-local only). Playback SAS minted per request (60 min). Response headers: `X-Robots-Tag: noindex`.
6. Report page gains a Share button → dialog: create (expiry select), copy-to-clipboard once, list + revoke existing links.

## Export

7. `GET /api/analyses/[id]/export?format=csv|json` (withOrg): json = the full report payload; csv = flat measures (id, kind, category, t_start_ms, t_end_ms, value_num, value_text, unit, confidence, provider_id) with proper escaping. Content-Disposition filenames like `jams-report-<runId>.<ext>`. Export buttons in the report header overflow menu.

## Tests + acceptance

8. Unit/route: token invariants (expired/revoked/invalid all identical 404s; no-auth access works for valid), share create/revoke org-scoped, CSV escaping (commas/quotes/newlines in value_text), export org-scoping. E2E: create share link via UI, open in a NEW unauthenticated browser context, assert report renders read-only (no save button), then revoke and assert 404.
9. `pnpm test/lint/build` + `pnpm test:e2e` (twice) green. User dirty files untouched. Finish: summary + scorecard row.
