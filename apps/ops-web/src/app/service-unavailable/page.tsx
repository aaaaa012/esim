"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function ServiceUnavailablePage() {
  const router = useRouter();
  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <section className="w-full max-w-xl rounded-xl border bg-card p-8">
        <h1 className="text-xl font-semibold">Operations service unavailable</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          We couldn't verify your staff session because the API did not respond.
          No administrative action was submitted.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => router.refresh()}>Try again</Button>
          <Button variant="outline" onClick={() => router.push("/sign-in")}>
            Sign in
          </Button>
        </div>
      </section>
    </main>
  );
}
