import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "./schema"

const connectionString =
  process.env.DATABASE_URL_WEB ??
  "postgresql://jams_web:jams_web@localhost:5432/jams"

/**
 * Connections per web replica. withOrg() holds one connection for the whole request transaction
 * (and some requests do blob I/O inside it), so this is effectively the number of requests a
 * replica can serve at once. It was 1, which serialized every request in the app behind whichever
 * was slowest.
 *
 * Budget on the B1ms server (max_connections 50, a few reserved for Azure): web 10 x maxReplicas
 * + admin 3 x maxReplicas + worker ~2 x maxExecutions. Revisit if either replica count grows.
 * Transaction-scoped set_config('app.org_id', ..., true) is safe with a pool: a transaction
 * always runs on one connection and the setting ends with it.
 */
export const WEB_POOL_MAX = Number(process.env.JAMS_WEB_DB_POOL_MAX ?? 10)

const queryClient = postgres(connectionString, {
  max: WEB_POOL_MAX,
  // Hand idle connections back so a scaled-down replica does not pin server slots.
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
})

export const db = drizzle(queryClient, { schema })
export type Db = typeof db
