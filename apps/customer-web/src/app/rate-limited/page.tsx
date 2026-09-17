"use client";

import { boundedRetryAfter, safeInternalReturnTo } from "@visa-compass/shared";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
    <main className="shell" id="main-content">
      <section className="account-empty">
        <h1>Account check temporarily busy</h1>
        <p>Your account is still signed in. Please wait briefly before retrying; no order or payment was changed.</p>
        <button className="button" disabled={seconds > 0} onClick={() => router.replace(returnTo)}>
          {seconds > 0 ? `Try again in ${seconds}s` : "Try again"}
        </button>
        <button className="button secondary" onClick={() => router.replace("/")}>Return home</button>
      </section>
    </main>
  );
}
