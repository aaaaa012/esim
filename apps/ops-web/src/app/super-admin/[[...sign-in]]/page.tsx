import Link from "next/link";
import { SignIn } from "@clerk/nextjs";

export default function SuperAdminSignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning-foreground">
          <b>Super Admin access</b>
          <p className="mt-1 text-warning-foreground/90">
            This sign-in is for a Super Admin account only. It grants full
            Administration and platform configuration access. Standard
            Operations staff should use the regular operations page below.
          </p>
        </div>
        <SignIn routing="path" path="/super-admin" forceRedirectUrl="/" />
        <p className="mt-3 text-center text-sm text-muted-foreground">
          Not a Super Admin?{" "}
          <Link href="/sign-in" className="underline">
            Go to the Operations Portal sign-in
          </Link>
        </p>
      </div>
    </main>
  );
}
