// Make the application roles' passwords match the ones infra gave the apps.
//
// Migration 0007 creates jams_web and jams_worker with placeholder passwords, and the web and
// worker connection strings are built from JAMS_WEB_DB_PASSWORD / JAMS_WORKER_DB_PASSWORD. If the
// two ever differ the apps cannot connect (this happened on staging in September 2026), and on a
// fresh database they always differ. Running after every migration keeps them in step.
//
// Env: DATABASE_URL (admin), JAMS_WEB_DB_PASSWORD, JAMS_WORKER_DB_PASSWORD. Never prints secrets.
import postgres from "postgres"

const roles = [
  ["jams_web", process.env.JAMS_WEB_DB_PASSWORD],
  ["jams_worker", process.env.JAMS_WORKER_DB_PASSWORD],
]

for (const [role, password] of roles) {
  if (!password || password.length < 16 || password === role) {
    console.error(`refusing to set ${role}: password missing, too short, or the placeholder`)
    process.exit(1)
  }
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} })
try {
  for (const [role, password] of roles) {
    // ALTER ROLE takes no bind parameters; let the server quote the literal with format(%L).
    const [{ statement }] = await sql`
      select format('ALTER ROLE %I WITH PASSWORD %L', ${role}::text, ${password}::text) as statement
    `
    await sql.unsafe(statement)
    console.log(`${role}: password in sync`)
  }
} finally {
  await sql.end()
}
