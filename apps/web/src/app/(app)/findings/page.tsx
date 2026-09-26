import { FindingsView } from "@/components/projects/FindingsView"

export const dynamic = "force-dynamic"
export const metadata = { title: "Findings - JAMS" }

export default function FindingsPage() {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Findings</h1>
        <p className="text-sm text-muted-foreground">
          What your sessions have shown, frozen when you saved it and checked against today&apos;s data.
        </p>
      </div>
      <FindingsView />
    </section>
  )
}
