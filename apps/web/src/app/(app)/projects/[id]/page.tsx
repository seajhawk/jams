import Link from "next/link"

import { CatalogView } from "@/components/projects/CatalogView"

export const dynamic = "force-dynamic"
export const metadata = { title: "Project - JAMS" }

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-8">
      <nav className="text-sm text-muted-foreground">
        <Link href="/projects" className="hover:underline">
          Projects
        </Link>
      </nav>
      <CatalogView projectId={id} />
    </section>
  )
}
