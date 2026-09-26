import { redirect } from "next/navigation"

/** Tasks became journeys inside projects and goals (U1). */
export default function TasksPage() {
  redirect("/projects")
}
