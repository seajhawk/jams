import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "./schema"

const adminConnectionString =
  process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"

// Small on purpose (see WEB_POOL_MAX in ./client for the server-wide budget), but not 1: every
// analysis dispatch, webhook and cleanup sweep shares it, so a single slow one stalled the rest.
const adminQueryClient = postgres(adminConnectionString, {
  max: Number(process.env.JAMS_ADMIN_DB_POOL_MAX ?? 3),
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
})

// Trusted server-only bypass connection. Use only for migrations/admin work and
// webhook mirror writes that cannot know tenant context before org rows exist.
export const adminDb = drizzle(adminQueryClient, { schema })
