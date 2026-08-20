"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";

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
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <section className="w-full max-w-xl rounded-xl border bg-card p-8 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight">
          Continue with your staff account
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Staff and Customer identities must remain separate. Continuing will
          sign out the current account, then open the staff sign-in. Your super
          admin has created your account and provided your credentials.
        </p>
        <Button
          className="mt-6"
          disabled={!isLoaded || working}
          onClick={() => void continueOnboarding()}
        >
          {working ? <Spinner className="text-primary-foreground" /> : null}
          {working ? "Switching account…" : "Continue to staff sign-in"}
        </Button>
      </section>
    </main>
  );
}
