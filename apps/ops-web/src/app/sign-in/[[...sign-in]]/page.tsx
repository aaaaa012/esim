import Link from "next/link";
import { SignIn } from "@clerk/nextjs";

export default function OperationsSignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <SignIn
          routing="path"
          path="/sign-in"
          forceRedirectUrl="/"
        />
        <p className="mt-3 text-center text-sm text-muted-foreground">
          Are you a Super Admin?{" "}
          <Link href="/super-admin" className="underline">
            Sign in as Super Admin
          </Link>
        </p>
      </div>
    </main>
  );
}
