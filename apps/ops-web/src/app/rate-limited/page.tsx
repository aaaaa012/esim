"use client";

import { boundedRetryAfter, safeInternalReturnTo } from "@visa-compass/shared";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function RateLimitedPage() {
  const router = useRouter();
  const [seconds, setSeconds] = useState(10);
  const [returnTo, setReturnTo] = useState("/");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSeconds(boundedRetryAfter(params.get("retryAfter")));
    setReturnTo(safeInternalReturnTo(params.get("returnTo")));
  }, []);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <section className="w-full max-w-xl rounded-xl border bg-card p-8">
        <h1 className="text-xl font-semibold">Session check temporarily busy</h1>
        <p className="mt-3 text-sm text-muted-foreground">Your staff account is still signed in. Please wait briefly before retrying; no administrative action was submitted.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button disabled={seconds > 0} onClick={() => router.replace(returnTo)}>{seconds > 0 ? `Try again in ${seconds}s` : "Try again"}</Button>
          <Button variant="outline" onClick={() => router.replace("/")}>Dashboard</Button>
        </div>
      </section>
    </main>
  );
}
