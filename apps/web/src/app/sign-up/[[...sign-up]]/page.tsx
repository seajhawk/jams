import { SignUp } from "@clerk/nextjs"

export const metadata = { title: "Sign up - JAMS" }

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
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
    </main>
  )
}
