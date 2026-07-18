import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "./schema"

const adminConnectionString =
  process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"

const adminQueryClient = postgres(adminConnectionString, {
  max: 1,
  prepare: false,
})

// Trusted server-only bypass connection. Use only for migrations/admin work and
// webhook mirror writes that cannot know tenant context before org rows exist.
export const adminDb = drizzle(adminQueryClient, { schema })
