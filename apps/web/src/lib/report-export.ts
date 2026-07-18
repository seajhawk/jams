import { and, asc, eq } from "drizzle-orm"

import { measures } from "@/db/schema"
import type { ReportPayload } from "@/lib/report-contract"
import type { OrgContext } from "@/lib/with-org"

type MeasureRow = typeof measures.$inferSelect

const CSV_COLUMNS = [
  "id",
  "kind",
  "category",
  "t_start_ms",
  "t_end_ms",
  "value_num",
  "value_text",
  "unit",
  "confidence",
  "provider_id",
] as const

export function csvEscape(value: string | number | null): string {
  if (value === null) return ""
  const raw = String(value)
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`
  }
  return raw
}

export function measuresToCsv(rows: MeasureRow[]): string {
  const lines = [
    CSV_COLUMNS.join(","),
    ...rows.map((row) =>
      [
        row.id,
        row.kind,
        row.category,
        row.tStartMs,
        row.tEndMs,
        row.valueNum,
        row.valueText,
        row.unit,
        row.confidence,
        row.providerId,
      ].map(csvEscape).join(",")
    ),
  ]
  return `${lines.join("\r\n")}\r\n`
}

export async function selectExportMeasures(
  scopedDb: OrgContext["scopedDb"],
  runId: string
) {
  return scopedDb.db
    .select()
    .from(measures)
    .where(
      and(
        eq(measures.runId, runId),
        eq(measures.orgId, scopedDb.orgId)
      )
    )
    .orderBy(asc(measures.tStartMs), asc(measures.kind), asc(measures.id))
}

export function reportJson(payload: ReportPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`
}
