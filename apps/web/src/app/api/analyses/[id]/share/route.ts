import { desc, eq } from "drizzle-orm"
import { z } from "zod"

import { analysisRuns, shareLinks } from "@/db/schema"
import { handleRouteError, HttpError, jsonError } from "@/lib/api"
import {
  expiryFromNow,
  generateShareToken,
  serializeShareLink,
  shareUrl,
} from "@/lib/share-links"
import { withOrg } from "@/lib/with-org"

export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()
const createShareSchema = z.object({
  expiry_days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
})

async function readCreateBody(request: Request) {
  const text = await request.text()
  let raw: unknown = {}

  if (text.trim()) {
    try {
      raw = JSON.parse(text)
    } catch {
      throw new HttpError(400, "Invalid JSON body")
    }
  }

  const parsed = createShareSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpError(400, z.prettifyError(parsed.error))
  }
  return parsed.data
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    return await withOrg(async ({ scopedDb }) => {
      const [run] = await scopedDb.db
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(scopedDb.orgFilter(analysisRuns, eq(analysisRuns.id, id)))
        .limit(1)

      if (!run) {
        return jsonError("Not found", 404)
      }

      const rows = await scopedDb.db
        .select()
        .from(shareLinks)
        .where(scopedDb.orgFilter(shareLinks, eq(shareLinks.runId, id)))
        .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id))

      return Response.json({ links: rows.map(serializeShareLink) })
    })
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!idSchema.safeParse(id).success) {
      return jsonError("Not found", 404)
    }

    const body = await readCreateBody(request)
    const origin = new URL(request.url).origin

    return await withOrg(async ({ orgId, userId, scopedDb }) => {
      const [run] = await scopedDb.db
        .select({ id: analysisRuns.id })
        .from(analysisRuns)
        .where(scopedDb.orgFilter(analysisRuns, eq(analysisRuns.id, id)))
        .limit(1)

      if (!run) {
        return jsonError("Not found", 404)
      }

      const token = generateShareToken()
      const [created] = await scopedDb.db
        .insert(shareLinks)
        .values({
          orgId,
          runId: id,
          token,
          expiresAt: expiryFromNow(body.expiry_days),
          createdBy: userId,
        })
        .returning()

      return Response.json(
        {
          link: serializeShareLink(created),
          token,
          url: shareUrl(origin, token),
        },
        { status: 201 }
      )
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
