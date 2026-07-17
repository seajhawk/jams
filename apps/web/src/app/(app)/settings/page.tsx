import { eq } from "drizzle-orm"

import { Badge } from "@/components/ui/badge"
import { db } from "@/db/client"
import { orgs } from "@/db/schema"
import { resolveOrgContext } from "@/lib/with-org"

export const metadata = { title: "Settings - JAMS" }

export default async function SettingsPage() {
  const context = await resolveOrgContext()
  const org = await db.query.orgs.findFirst({
    where: eq(orgs.id, context.orgId),
  })

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Workspace identity and billing plan.
        </p>
      </div>

      <div className="rounded-lg border bg-background p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Workspace</p>
            <p className="mt-1 text-lg font-medium">
              {org?.name ?? "Personal workspace"}
            </p>
          </div>
          <Badge variant="secondary" className="rounded-md">
            Free
          </Badge>
        </div>
      </div>
    </section>
  )
}
