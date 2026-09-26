import { and, eq, inArray, isNull } from "drizzle-orm"

import { analysisRuns } from "@/db/schema"
import type { OrgContext } from "@/lib/with-org"

type AnalysisRunRow = typeof analysisRuns.$inferSelect

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` compare equal (jsonb reorders keys). */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value ?? null))
}

/**
 * Double-submit protection for analysis creation. If the recording already has a current (not
 * superseded) queued or running analysis with the same configuration, that run is the answer to
 * the repeated request, and no second run is queued or billed.
 *
 * Call it after locking the video row (`FOR UPDATE`): the lock serializes concurrent requests for
 * the same recording, so two simultaneous submits cannot both miss each other.
 */
export async function findDuplicateActiveRun(
  scopedDb: OrgContext["scopedDb"],
  input: { videoId: string; config: unknown; configSource: string | null }
): Promise<AnalysisRunRow | null> {
  const [run] = await scopedDb.db
    .select()
    .from(analysisRuns)
    .where(
      scopedDb.orgFilter(
        analysisRuns,
        and(
          eq(analysisRuns.videoId, input.videoId),
          isNull(analysisRuns.supersededBy),
          inArray(analysisRuns.status, ["queued", "running"])
        )
      )
    )
    .limit(1)

  if (!run) return null
  if (stableJson(run.config) !== stableJson(input.config)) return null
  if ((run.configSource ?? null) !== input.configSource) return null
  return run
}
