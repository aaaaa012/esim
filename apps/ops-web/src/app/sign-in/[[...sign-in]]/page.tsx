import Link from "next/link";
import { SignIn } from "@clerk/nextjs";

export default function OperationsSignInPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <SignIn
          routing="path"
          path="/sign-in"
          forceRedirectUrl="/"
        />
        <p className="mt-3 text-center text-sm text-slate-500">
          Are you a Super Admin?{" "}
          <Link href="/super-admin" className="underline">
            Sign in as Super Admin
          </Link>
        </p>
      </div>
    </main>
  );
}
