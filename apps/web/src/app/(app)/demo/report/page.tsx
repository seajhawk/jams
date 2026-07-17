import demoReport from "../../../../../../../fixtures/demo-report.v1.json"
import { ReportShell } from "@/components/report/ReportShell"
import { reportPayloadSchema } from "@/lib/report-contract"

export const metadata = { title: "Demo Report - JAMS" }

export default function DemoReportPage() {
  const payload = reportPayloadSchema.parse(demoReport)
  return <ReportShell payload={payload} demo />
}
