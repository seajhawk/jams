# Spec F1-c: Clerk auth, hidden personal orgs, webhook mirror

Goal: authentication + the org model from `docs/PLAN.md` (§Architecture/Multi-tenancy, §Data model). Branch `f1-foundation`. Runs AFTER f1-scaffold.md and f1-demo-report.md have landed (report page exists at /demo/report).

## Scope

1. **Clerk integration** (`@clerk/nextjs`, current stable): middleware protecting everything except `/`, `/sign-in`, `/sign-up`, `/api/webhooks/*`; `<ClerkProvider>` in root layout; sign-in/sign-up routes using Clerk components styled to blend with our Tailwind theme; `<OrganizationSwitcher hidePersonal={false}>` NOT used yet — instead `<UserButton>` only (org switching UI comes when multi-user orgs ship; personal orgs stay invisible).
2. **Personal org auto-create:** on first sign-in ensure a personal Clerk organization exists for the user (name from their display name, private metadata `{ personal: true }`) and is set active — implement in the `user.created` webhook handler (create org via Clerk backend SDK) with an idempotent fallback check in `withOrg`.
3. **Drizzle + Postgres:** set up drizzle-orm + drizzle-kit against `DATABASE_URL` (docker-compose Postgres locally). Tables per PLAN.md §Data model: `orgs`, `users`, `webhook_events` only (later tables come with their features). Generate the initial migration; `pnpm db:migrate` script.
4. **Webhook mirror:** `POST /api/webhooks/clerk` — svix-verified; handles `user.created/updated/deleted`, `organization.created/updated/deleted`, `organizationMembership.created/deleted`; every event first inserted into `webhook_events` (unique external_id = svix id; skip if exists), then applied (upsert/soft-handle deletes).
5. **withOrg chokepoint:** `apps/web/src/lib/with-org.ts` — wraps route handlers/server components: resolves `{ userId, orgId }` from Clerk session claims (`auth()`), 401s if absent, guarantees a personal org (creating + activating if missing), and returns an org-scoped helper `scopedDb` that pre-binds `org_id` filters for Drizzle queries. All future API routes use this — export a clear usage example in the file's JSDoc.
6. **App shell:** authenticated layout with left sidebar (Library, Tasks, Settings — Library shows an empty state teaching "upload your first journey"; Settings shows org name + plan chip "Free"), `/demo/report` linked from a "Sample report" card on Library. Polished shadcn styling per AGENTS.md.
7. **Env:** extend `.env.example` with CLERK_* keys (placeholders) + `CLERK_WEBHOOK_SIGNING_SECRET`; document in readme that Chris must create the Clerk app and paste keys. All code must build and unit-test WITHOUT real Clerk keys (guard imports; webhook handler unit-tested with fake svix signatures).

## Acceptance

- `pnpm build`, `pnpm lint`, `pnpm test` pass with placeholder env values; webhook idempotency + withOrg unit tests included (mock Clerk).
- Migration applies cleanly to the docker-compose Postgres.
- Commits on `f1-foundation`; do not push. Finish with commit list, verification results, and a numbered list of manual steps Chris must do (Clerk app creation, keys, webhook endpoint config).
