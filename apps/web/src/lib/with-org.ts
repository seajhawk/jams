import { auth } from "@clerk/nextjs/server"
import { and, eq, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { db } from "@/db/client"
import { ensurePersonalOrganization } from "./clerk/personal-org"
import type { ClerkBackendClient, MirrorStore } from "./clerk/types"

type AuthSession = Awaited<ReturnType<typeof auth>>

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
    db: typeof db
    orgFilter<TTable extends OrgScopedTable>(
      table: TTable,
      extra?: SQL
    ): SQL
  }
}

type ResolveOrgContextDeps = {
  authFn?: () => Promise<Pick<AuthSession, "userId" | "orgId" | "sessionClaims">>
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

export function createScopedDb(orgId: string): OrgContext["scopedDb"] {
  return {
    orgId,
    db,
    orgFilter(table, extra) {
      const scoped = eq(table.orgId, orgId)
      return extra ? and(scoped, extra) ?? scoped : scoped
    },
  }
}

export async function resolveOrgContext({
  authFn = auth,
  clerk,
  store,
}: ResolveOrgContextDeps = {}): Promise<OrgContext> {
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
    scopedDb: createScopedDb(orgId),
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
  const context = await resolveOrgContext()
  return handler(context)
}

export function isUnauthorized(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError
}
