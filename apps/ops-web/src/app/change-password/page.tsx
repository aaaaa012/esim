"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
import ErrorDialog from "@/components/error-dialog";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export default function ChangePasswordPage() {
  const router = useRouter();
  const authFetch = useAuthenticatedFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const finish = async () => {
    if (password.length < 12) {
      setError("Choose a password of at least 12 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("The password confirmation does not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(`${API}/auth/me/password-changed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: password }),
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
        <h1 className="text-xl font-semibold tracking-tight">
          Set a new password
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account was provisioned with a temporary password. Set a strong
          new password below, then continue to the console.
        </p>
      </div>
      <div className="space-y-4">
        <label className="block text-sm font-medium" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          className="w-full rounded-md border bg-background px-3 py-2"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <label className="block text-sm font-medium" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          className="w-full rounded-md border bg-background px-3 py-2"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      <ErrorDialog error={error} onClose={() => setError("")} />
      <Button onClick={() => void finish()} disabled={busy}>
        {busy ? <Spinner className="text-primary-foreground" /> : null}
        {busy ? "Updating password..." : "Set new password"}
      </Button>
    </section>
  );
}
