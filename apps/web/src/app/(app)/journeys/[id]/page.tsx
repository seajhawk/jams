import { JourneyView } from "@/components/projects/JourneyView"

export const dynamic = "force-dynamic"
export const metadata = { title: "Journey - JAMS" }

export default async function JourneyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-8">
      <JourneyView journeyId={id} />
    </section>
  )
}
