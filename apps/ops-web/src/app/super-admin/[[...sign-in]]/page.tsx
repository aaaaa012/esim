import Link from "next/link";
import { SignIn } from "@clerk/nextjs";

export default function SuperAdminSignInPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <b>Super Admin access</b>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            This sign-in is for a Super Admin account only. It grants full
            Administration and platform configuration access. Standard
            Operations staff should use the regular operations page below.
          </p>
        </div>
        <SignIn routing="path" path="/super-admin" forceRedirectUrl="/" />
        <p className="mt-3 text-center text-sm text-slate-500">
          Not a Super Admin?{" "}
          <Link href="/sign-in" className="underline">
            Go to the Operations Portal sign-in
          </Link>
        </p>
      </div>
    </main>
  );
}