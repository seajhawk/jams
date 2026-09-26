import Link from "next/link"
import type { ReactNode } from "react"

import { contactEmail } from "@/lib/contact"

export function ContactLine() {
  const email = contactEmail()
  return email ? (
    <a className="underline underline-offset-4" href={`mailto:${email}`}>
      {email}
    </a>
  ) : (
    <>the person who invited you to the preview</>
  )
}

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string
  updated: string
  children: ReactNode
}) {
  return (
    <main className="min-h-screen bg-background">
      <article className="mx-auto w-full max-w-2xl space-y-6 px-6 py-12 text-sm leading-7 text-foreground [&_h2]:pt-2 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:text-muted-foreground [&_ul]:space-y-1 [&_ul]:text-muted-foreground">
        <Link href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
          JAMS
        </Link>
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold">{title}</h1>
          <p className="text-muted-foreground">Last updated {updated}</p>
        </header>
        {children}
        <footer className="flex gap-4 border-t pt-6 text-muted-foreground">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/">Home</Link>
        </footer>
      </article>
    </main>
  )
}
