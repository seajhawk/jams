import { auth } from "@clerk/nextjs/server"
import { and, eq, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { db } from "@/db/client"
import { ensurePersonalOrganization } from "./clerk/personal-org"
import type { ClerkBackendClient, MirrorStore } from "./clerk/types"

type AuthSession = Awaited<ReturnType<typeof auth>>
type TransactionDb = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type ScopedDbClient = typeof db | TransactionDb

type OrgScopedTable = {
  orgId: PgColumn
}

export class UnauthorizedError extends Error {
  readonly status = 401
}

export type OrgContext = {
  userId: string
  orgId: string
  scopedDb: {
    orgId: string
    db: ScopedDbClient
    orgFilter<TTable extends OrgScopedTable>(
      table: TTable,
      extra?: SQL
    ): SQL
  }
}

export type ResolvedOrgContext = Pick<OrgContext, "userId" | "orgId">

type AuthContext = Pick<AuthSession, "userId" | "orgId"> & {
  sessionClaims: unknown
}

type ResolveOrgContextDeps = {
  authFn?: () => Promise<AuthContext>
  clerk?: ClerkBackendClient
  store?: Pick<MirrorStore, "upsertOrg">
}

function claimString(claims: unknown, key: string): string | null {
  if (typeof claims !== "object" || claims === null || !(key in claims)) {
    return null
  }

  const value = claims[key as keyof typeof claims]
  return typeof value === "string" ? value : null
}

function fallbackNameFromClaims(claims: unknown): string | null {
  return (
    claimString(claims, "name") ??
    claimString(claims, "full_name") ??
    claimString(claims, "email")
  )
}

export function createScopedDb(
  orgId: string,
  scopedConnection: ScopedDbClient
): OrgContext["scopedDb"] {
  return {
    orgId,
    db: scopedConnection,
    orgFilter(table, extra) {
      const scoped = eq(table.orgId, orgId)
      return extra ? and(scoped, extra) ?? scoped : scoped
    },
  }
}

export async function bindOrgToTransaction(
  scopedConnection: ScopedDbClient,
  orgId: string
): Promise<OrgContext["scopedDb"]> {
  // Parameterized SET LOCAL equivalent; scoped to this transaction only.
  await scopedConnection.execute(sql`select set_config('app.org_id', ${orgId}, true)`)
  return createScopedDb(orgId, scopedConnection)
}

export async function withScopedDb<T>(
  orgId: string,
  handler: (scopedDb: OrgContext["scopedDb"]) => Promise<T> | T
): Promise<T> {
  return db.transaction(async (tx) => {
    const scopedDb = await bindOrgToTransaction(tx, orgId)
    return handler(scopedDb)
  })
}

export async function withDbTransaction<T>(
  handler: (tx: TransactionDb) => Promise<T> | T
): Promise<T> {
  return db.transaction(async (tx) => handler(tx))
}

export async function resolveOrgContext({
  authFn = auth,
  clerk,
  store,
}: ResolveOrgContextDeps = {}): Promise<ResolvedOrgContext> {
  const session = await authFn()

  if (!session.userId) {
    throw new UnauthorizedError("Authentication required")
  }

  const orgId = await ensurePersonalOrganization({
    userId: session.userId,
    activeOrgId: session.orgId,
    fallbackName: fallbackNameFromClaims(session.sessionClaims),
    clerk,
    store,
  })

  return {
    userId: session.userId,
    orgId,
  }
}

/**
 * Chokepoint for tenant-owned server work.
 *
 * @example
 * export async function GET() {
 *   return withOrg(async ({ scopedDb }) => {
 *     const rows = await scopedDb.db
 *       .select()
 *       .from(tasks)
 *       .where(scopedDb.orgFilter(tasks))
 *
 *     return Response.json(rows)
 *   })
 * }
 */
export async function withOrg<T>(
  handler: (context: OrgContext) => Promise<T> | T
): Promise<T> {
  const { userId, orgId } = await resolveOrgContext()
  return withScopedDb(orgId, (scopedDb) => handler({ userId, orgId, scopedDb }))
}

export function isUnauthorized(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError
}
