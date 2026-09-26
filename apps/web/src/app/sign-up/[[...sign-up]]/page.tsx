import { SignUp } from "@clerk/nextjs"
import Link from "next/link"

export const metadata = { title: "Sign up - JAMS" }

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/30 px-4 py-12">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/library"
        appearance={{
          elements: {
            rootBox: "w-full max-w-md",
            card: "shadow-sm border border-border rounded-lg",
          },
        }}
      />
      <p className="max-w-md text-center text-xs text-muted-foreground">
        By creating an account you agree to the{" "}
        <Link href="/terms" className="underline underline-offset-4">preview terms</Link> and the{" "}
        <Link href="/privacy" className="underline underline-offset-4">privacy page</Link>.
      </p>
    </main>
  )
}
