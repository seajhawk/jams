import { Toaster } from "@/components/ui/sonner"
import { requirePlatformAdminPage } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requirePlatformAdminPage()

  return (
    <>
      {children}
      <Toaster />
    </>
  )
}
