import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function UnauthorizedPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <section className="w-full max-w-xl rounded-xl border bg-card p-8 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight">
          This account can&apos;t access the operations console
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The account you signed in with doesn&apos;t have staff access. Only
          OPERATIONS or SUPER_ADMIN accounts can use this portal. If you
          believe this is a mistake, contact your administrator.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/sign-in">Sign in with a staff account</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Go to customer portal</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}