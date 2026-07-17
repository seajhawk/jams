import demoReport from '../../../../../../fixtures/demo-report.v1.json'
import { reportPayloadSchema } from '@/lib/report-contract'
import { ReportShell } from '@/components/report/ReportShell'

export const metadata = { title: 'Demo Report — JAMS' }

export default function DemoReportPage() {
  const payload = reportPayloadSchema.parse(demoReport)
  return <ReportShell payload={payload} />
}
