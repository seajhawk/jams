import { CatalogView } from "@/components/projects/CatalogView"

export const dynamic = "force-dynamic"
export const metadata = { title: "Projects - JAMS" }

export default function ProjectsPage() {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Your products, the goals people use them for, and the journeys that reach each goal.
        </p>
      </div>
      <CatalogView />
    </section>
  )
}
