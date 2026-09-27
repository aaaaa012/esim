"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body><main className="shell"><section className="account-empty"><h1>Visa Compass is temporarily unavailable</h1><p>We couldn’t start the application. Your payment and order information have not been changed.</p><button className="button" onClick={reset}>Try again</button><a className="button secondary" href="/">Reload home</a></section></main></body></html>;
}
