"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("customer_route_failed", { digest: error.digest }); }, [error]);
  return <main className="shell" id="main-content"><section className="account-empty"><h1>We couldn’t load this page</h1><p>Your information is safe. Check your connection and try again.</p><button className="button" onClick={reset}>Try again</button><a className="button secondary" href="/">Return home</a></section></main>;
}
