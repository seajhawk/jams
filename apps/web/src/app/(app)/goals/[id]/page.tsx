import { GoalView } from "@/components/projects/GoalView"

export const dynamic = "force-dynamic"
export const metadata = { title: "Goal - JAMS" }

export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <GoalView goalId={id} />
    </section>
  )
}
