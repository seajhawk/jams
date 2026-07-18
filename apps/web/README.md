# JAMS Web

Next.js 16 app for the JAMS SaaS UI, Clerk auth, API route handlers, and
Drizzle-owned Postgres DDL.

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Database

Database migrations are generated from `src/db/schema.ts` and applied with:

```bash
pnpm db:generate
pnpm db:migrate
```

## Clerk

The app builds and tests with placeholder Clerk env values. For real auth,
create a Clerk app with Organizations enabled and set:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SIGNING_SECRET`

The webhook endpoint is `/api/webhooks/clerk`.
