import { UserButton } from "@clerk/nextjs"
import { eq } from "drizzle-orm"
import { BarChart3, ClipboardList, FolderOpen, Settings } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { db } from "@/db/client"
import { orgs } from "@/db/schema"
import { resolveOrgContext } from "@/lib/with-org"
import { ActiveOrgSync } from "./ActiveOrgSync"

const navItems = [
  { href: "/library", label: "Library", icon: FolderOpen },
  { href: "/tasks", label: "Tasks", icon: ClipboardList },
  { href: "/settings", label: "Settings", icon: Settings },
]

export async function AppShell({ children }: { children: React.ReactNode }) {
  const context = await resolveOrgContext()
  const org = await db.query.orgs.findFirst({
    where: eq(orgs.id, context.orgId),
  })
  const orgName = org?.name ?? "Personal workspace"

  return (
    <div className="flex min-h-screen bg-muted/25">
      <ActiveOrgSync orgId={context.orgId} />
      <aside className="hidden w-64 shrink-0 border-r bg-background md:flex md:flex-col">
        <div className="flex h-16 items-center gap-2 px-5">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BarChart3 className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">JAMS</p>
            <p className="text-xs text-muted-foreground">Effort analysis</p>
          </div>
        </div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="space-y-3 border-t p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{orgName}</p>
            <Badge variant="secondary" className="mt-1 rounded-md">
              Free
            </Badge>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-background px-4 md:h-16 md:px-6">
          <div className="md:hidden">
            <p className="text-sm font-semibold">JAMS</p>
            <p className="text-xs text-muted-foreground">{orgName}</p>
          </div>
          <nav className="hidden gap-1 md:flex">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <UserButton />
        </header>
        <main className="flex-1">{children}</main>
      </div>
    </div>
  )
}
