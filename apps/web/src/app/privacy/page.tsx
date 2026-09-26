import type { Metadata } from "next"

import { ContactLine, LegalPage } from "@/components/legal/LegalPage"
import { operatorName } from "@/lib/contact"

// Contact and operator come from runtime settings, not the build.
export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Privacy · JAMS" }

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy during the preview" updated="September 26, 2026">
      <p>
        JAMS is in a private preview run by {operatorName()}. This page explains, in plain words,
        what happens to the recordings you upload. Questions or requests: <ContactLine />.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>Your account: name and email address, held by our sign-in provider, Clerk.</li>
        <li>
          The recordings you upload, and what JAMS derives from them: the transcript of any
          narration, timestamped measures, scores, thumbnails and reports.
        </li>
        <li>The projects, journeys, tasks and notes you create.</li>
        <li>Basic service logs (for example request times and errors) used to keep JAMS running.</li>
      </ul>

      <h2>Where it is stored and processed</h2>
      <p>
        Recordings and results are stored in Microsoft Azure in the East US 2 region. Transcription
        and analysis run on JAMS&apos;s own servers there. We do not send your recordings or
        transcripts to third-party AI services, and we do not use them to train models.
      </p>

      <h2>Who can see it</h2>
      <ul>
        <li>You, and the members of the workspace you uploaded to.</li>
        <li>
          Anyone you give a share link to, while the link is valid. You can revoke a link at any
          time, and every link expires.
        </li>
        <li>
          {operatorName()}, only when needed to operate the service, fix a problem or answer a
          request from you.
        </li>
      </ul>

      <h2>Retention and deletion</h2>
      <p>
        Recordings stay until you delete them. Deleting a recording removes the video, its
        analyses, reports and share links; stored files are removed straight away, with follow-up
        checks that catch anything left behind. A small
        record that the recording existed (its identifiers and your usage count) is kept so usage
        limits stay accurate. To delete your whole account and everything in it, contact{" "}
        <ContactLine />. If the preview ends, we will tell you before deleting anything.
      </p>

      <h2>Recording other people</h2>
      <p>
        Only upload recordings you have the right to share. If a recording shows or narrates other
        people, or contains personal or confidential information, make sure you have their consent
        and that your organization allows it.
      </p>
    </LegalPage>
  )
}
