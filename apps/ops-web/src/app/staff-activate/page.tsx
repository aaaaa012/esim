"use client";

import { useClerk } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
import ErrorDialog from "@/components/error-dialog";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export default function StaffActivatePage() {
  const params = useSearchParams();
  const { signOut } = useClerk();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = params.get("token") ?? "";

  const activate = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!token) return setError("This activation link is invalid or incomplete.");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setBusy(true);
    try {
      const response = await fetch(`${API}/staff-activation/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body?.error?.message ?? "Unable to activate account";
        const code = body?.error?.code;
        const correlationId = body?.meta?.correlationId;
        const reference = [code, correlationId].filter(Boolean).join(" / ");
        throw new Error(reference ? `${message} Reference: ${reference}` : message);
      }
      await signOut({ redirectUrl: "/sign-in?activated=1" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to activate account");
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <form onSubmit={activate} className="w-full max-w-md rounded-xl border bg-card p-8 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight">Activate staff account</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Choose a password for the Visa Compass Operations portal. This activation link can be used once.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="password">Password</label>
        <input id="password" className="mt-2 w-full rounded-md border bg-background px-3 py-2" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} />
        <label className="mt-4 block text-sm font-medium" htmlFor="confirm-password">Confirm password</label>
        <input id="confirm-password" className="mt-2 w-full rounded-md border bg-background px-3 py-2" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        <Button className="mt-6 w-full" type="submit" disabled={busy}>
          {busy ? <Spinner className="text-primary-foreground" /> : null}
          {busy ? "Activating…" : "Activate account"}
        </Button>
      </form>
      <ErrorDialog error={error} onClose={() => setError("")} />
    </main>
  );
}
