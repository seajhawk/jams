import { SignIn } from "@clerk/nextjs"

export const metadata = { title: "Sign in - JAMS" }

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
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
