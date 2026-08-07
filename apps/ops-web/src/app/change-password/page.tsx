"use client";

import { UserProfile } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export default function ChangePasswordPage() {
  const router = useRouter();
  const authFetch = useAuthenticatedFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(`${API}/auth/me/password-changed`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body?.error?.message ?? "Request failed");
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 rounded-xl border bg-card p-6 shadow-card sm:p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Set a new password</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account was provisioned with a temporary password. Set a strong
          new password below, then continue to the console.
        </p>
      </div>
      <UserProfile routing="path" path="/change-password" />
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button onClick={() => void finish()} disabled={busy}>
        {busy ? <Spinner className="text-primary-foreground" /> : null}
        {busy ? "Continuing…" : "I've set my new password — continue"}
      </Button>
    </section>
  );
}