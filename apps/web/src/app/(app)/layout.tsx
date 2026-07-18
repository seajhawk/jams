import { AppShell } from "@/components/app/AppShell"
import { Toaster } from "@/components/ui/sonner"

export const dynamic = "force-dynamic"

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <AppShell>{children}</AppShell>
      <Toaster />
    </>
  )
}
