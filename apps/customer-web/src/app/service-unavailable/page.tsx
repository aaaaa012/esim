"use client";

import { useRouter } from "next/navigation";

export default function ServiceUnavailablePage() {
  const router = useRouter();
  return (
    <main className="shell" id="main-content">
      <section className="account-empty">
        <h1>Service temporarily unavailable</h1>
        <p>
          We couldn't verify your account because the service did not respond.
          Your orders have not been changed.
        </p>
        <button className="button" onClick={() => router.refresh()}>
          Try again
        </button>
        <button className="button secondary" onClick={() => router.push("/")}>
          Return home
        </button>
      </section>
    </main>
  );
}
