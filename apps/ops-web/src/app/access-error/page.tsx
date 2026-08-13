"use client";

import { useClerk } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

export default function AccessErrorPage() {
  const { signOut } = useClerk();
  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <section className="w-full max-w-xl rounded-xl border bg-card p-8 shadow-card">
        <h1 className="text-xl font-semibold">Operations access could not be verified</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Your account is not permitted to use this portal, or the identity service is temporarily unavailable. No operations data has been loaded.
        </p>
        <div className="mt-6 flex gap-3">
          <Button onClick={() => window.location.assign("/")}>Retry</Button>
          <Button variant="outline" onClick={() => void signOut({ redirectUrl: "/sign-in" })}>Sign out</Button>
        </div>
      </section>
    </main>
  );
}
