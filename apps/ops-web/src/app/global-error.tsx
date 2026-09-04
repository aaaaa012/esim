"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body><main className="grid min-h-dvh place-items-center p-4"><section><h1>Operations portal unavailable</h1><p>No administrative action was submitted.</p><button onClick={reset}>Try again</button></section></main></body></html>;
}
