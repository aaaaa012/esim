"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useState } from "react";

export default function StaffOnboardingPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const [working, setWorking] = useState(false);

  const continueOnboarding = async () => {
    setWorking(true);
    const destination = `/sign-in`;
    if (isSignedIn) await clerk.signOut({ redirectUrl: destination });
    else window.location.replace(destination);
  };

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 dark:bg-slate-950">
      <section className="panel" style={{ maxWidth: 520 }}>
        <h1>Continue with your staff account</h1>
        <p>
          Staff and Customer identities must remain separate. Continuing will
          sign out the current account, then open the staff sign-in. Your super
          admin has created your account and provided your credentials.
        </p>
        <button
          className="primary-action"
          disabled={!isLoaded || working}
          onClick={() => void continueOnboarding()}
        >
          {working ? "Switching account…" : "Continue to staff sign-in"}
        </button>
      </section>
    </main>
  );
}
