import type { Metadata } from "next"

import { ContactLine, LegalPage } from "@/components/legal/LegalPage"
import { operatorName } from "@/lib/contact"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Terms · JAMS" }

export default function TermsPage() {
  return (
    <LegalPage title="Preview terms" updated="September 26, 2026">
      <p>
        These terms cover the private preview of JAMS, run by {operatorName()}. By using the
        preview you agree to them. Questions: <ContactLine />.
      </p>

      <h2>A preview, provided as is</h2>
      <p>
        JAMS is early software. Features, limits and results will change, the service may be
        unavailable at times, and we may end the preview. It is provided as is, without
        warranties, and to the extent the law allows we are not liable for losses from using it.
        Keep your own copies of recordings that matter to you.
      </p>

      <h2>Results are experimental</h2>
      <p>
        Effort scores, sentiment and other measures are experimental indicators for comparing
        sessions of the same task. They are not validated measures of workload, performance or
        wellbeing, and should not be used to make decisions about individuals.
      </p>

      <h2>Your content</h2>
      <p>
        You keep ownership of your recordings and notes. You give us permission to store and
        process them only to provide JAMS to you. See the <a className="underline underline-offset-4" href="/privacy">privacy page</a>{" "}
        for how they are handled.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Upload only recordings you have the right to share, with consent from anyone in them.</li>
        <li>Do not upload unlawful content or content that infringes others&apos; rights.</li>
        <li>
          Do not try to get around usage limits, access other workspaces, or disrupt the service.
        </li>
      </ul>
      <p>We may suspend access that breaks these terms.</p>

      <h2>Pricing</h2>
      <p>The preview is free. If paid plans are introduced, we will tell you before anything is charged.</p>
    </LegalPage>
  )
}
