"use client";

import { useClerk } from "@clerk/nextjs";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

type FieldErrors = Partial<
  Record<"firstName" | "lastName" | "password" | "confirmPassword", string>
>;

export default function StaffActivatePage() {
  const params = useSearchParams();
  const { signOut } = useClerk();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [activated, setActivated] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const token = params.get("token") ?? "";

  const clearFieldErrors = (...fields: Array<keyof FieldErrors>) => {
    setFieldErrors((current) => {
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });
  };

  const validate = () => {
    const next: FieldErrors = {};
    if (!firstName.trim()) next.firstName = "Enter your first name.";
    if (!lastName.trim()) next.lastName = "Enter your last name.";
    if (password.length < 12)
      next.password = "Use at least 12 characters.";
    if (!confirmPassword)
      next.confirmPassword = "Confirm your password.";
    else if (password !== confirmPassword)
      next.confirmPassword = "Passwords do not match.";
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const activate = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!token) return setError("This activation link is invalid or incomplete.");
    if (!validate()) return;
    setBusy(true);
    try {
      const response = await fetch(`${API}/staff-activation/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          password,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body?.error?.message ?? "Unable to activate account";
        const code = body?.error?.code;
        const correlationId = body?.meta?.correlationId;
        const reference = [code, correlationId].filter(Boolean).join(" / ");
        throw new Error(reference ? `${message} Reference: ${reference}` : message);
      }
      setActivated(true);
      setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to activate account");
      setBusy(false);
    }
  };

  const continueToSignIn = async () => {
    setLeaving(true);
    try {
      await signOut({ redirectUrl: "/sign-in?activated=1" });
    } catch {
      window.location.assign("/sign-in?activated=1");
    }
  };

  if (activated) {
    return (
      <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
        <section
          className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-card"
          aria-labelledby="activation-success-title"
        >
          <span className="mx-auto flex size-12 items-center justify-center rounded-lg bg-success/10 text-success">
            <CheckCircle2 className="size-6" aria-hidden="true" />
          </span>
          <h1 id="activation-success-title" className="mt-5 text-xl font-semibold tracking-tight">
            Staff account activated
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Your account is ready. Continue to sign in to Visa Compass Operations, or close this window.
          </p>
          <div className="mt-6 grid gap-3">
            <Button type="button" onClick={continueToSignIn} disabled={leaving}>
              {leaving ? <Spinner className="text-primary-foreground" /> : null}
              {leaving ? "Opening sign in..." : "Continue to sign in"}
            </Button>
            <Button type="button" variant="outline" onClick={() => window.close()}>
              Close window
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <form noValidate onSubmit={activate} className="w-full max-w-md rounded-xl border bg-card p-8 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight">Activate staff account</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Enter your name and choose a password for the Visa Compass Operations portal. This activation link can be used once.
        </p>
        {error ? (
          <div role="alert" className="mt-5 flex gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
        ) : null}
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="first-name">First name</label>
            <input id="first-name" name="firstName" className="mt-2 w-full rounded-md border bg-background px-3 py-2 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/30" type="text" autoComplete="given-name" maxLength={100} required aria-invalid={Boolean(fieldErrors.firstName)} aria-describedby={fieldErrors.firstName ? "first-name-error" : undefined} value={firstName} onChange={(event) => { setFirstName(event.target.value); clearFieldErrors("firstName"); }} />
            {fieldErrors.firstName ? <p id="first-name-error" className="mt-1.5 text-xs text-destructive">{fieldErrors.firstName}</p> : null}
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="last-name">Last name</label>
            <input id="last-name" name="lastName" className="mt-2 w-full rounded-md border bg-background px-3 py-2 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/30" type="text" autoComplete="family-name" maxLength={100} required aria-invalid={Boolean(fieldErrors.lastName)} aria-describedby={fieldErrors.lastName ? "last-name-error" : undefined} value={lastName} onChange={(event) => { setLastName(event.target.value); clearFieldErrors("lastName"); }} />
            {fieldErrors.lastName ? <p id="last-name-error" className="mt-1.5 text-xs text-destructive">{fieldErrors.lastName}</p> : null}
          </div>
        </div>
        <label className="mt-4 block text-sm font-medium" htmlFor="password">Password</label>
        <input id="password" className="mt-2 w-full rounded-md border bg-background px-3 py-2 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/30" type="password" autoComplete="new-password" minLength={12} required aria-invalid={Boolean(fieldErrors.password)} aria-describedby="password-help" value={password} onChange={(event) => { setPassword(event.target.value); clearFieldErrors("password", "confirmPassword"); }} />
        <p id="password-help" className={`mt-1.5 text-xs ${fieldErrors.password ? "text-destructive" : "text-muted-foreground"}`}>{fieldErrors.password ?? "Use at least 12 characters and avoid common passwords."}</p>
        <label className="mt-4 block text-sm font-medium" htmlFor="confirm-password">Confirm password</label>
        <input id="confirm-password" className="mt-2 w-full rounded-md border bg-background px-3 py-2 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/30" type="password" autoComplete="new-password" minLength={12} required aria-invalid={Boolean(fieldErrors.confirmPassword)} aria-describedby={fieldErrors.confirmPassword ? "confirm-password-error" : undefined} value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); clearFieldErrors("confirmPassword"); }} />
        {fieldErrors.confirmPassword ? <p id="confirm-password-error" className="mt-1.5 text-xs text-destructive">{fieldErrors.confirmPassword}</p> : null}
        <Button className="mt-6 w-full" type="submit" disabled={busy}>
          {busy ? <Spinner className="text-primary-foreground" /> : null}
          {busy ? "Activating…" : "Activate account"}
        </Button>
      </form>
    </main>
  );
}
