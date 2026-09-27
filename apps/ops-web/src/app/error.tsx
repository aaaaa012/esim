"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("ops_route_failed", { digest: error.digest }); }, [error]);
  return <main className="grid min-h-[70dvh] place-items-center px-4"><section className="w-full max-w-xl rounded-xl border bg-card p-8"><h1 className="text-xl font-semibold">This workspace could not be loaded</h1><p className="mt-3 text-sm text-muted-foreground">No operation was submitted. Retry, or return to the dashboard.</p><div className="mt-6 flex gap-3"><Button onClick={reset}>Try again</Button><Button variant="outline" onClick={() => window.location.assign("/")}>Dashboard</Button></div></section></main>;
}
