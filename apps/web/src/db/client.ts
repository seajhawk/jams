import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "./schema"

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams"

const queryClient = postgres(connectionString, {
  max: 1,
  prepare: false,
})

export const db = drizzle(queryClient, { schema })
export type Db = typeof db
