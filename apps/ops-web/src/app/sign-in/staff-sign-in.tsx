"use client";

import { useSignIn } from "@clerk/nextjs";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
import { toast } from "sonner";

type Step = "sign-in" | "second-factor" | "reset-code" | "new-password";

function clerkMessage(error: unknown, fallback: string) {
  const candidate = error as { errors?: Array<{ longMessage?: string; message?: string }> };
  return candidate?.errors?.[0]?.longMessage ?? candidate?.errors?.[0]?.message ?? fallback;
}

export default function StaffSignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const router = useRouter();
  const [step, setStep] = useState<Step>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!error) return;
    toast.error(error, { id: "staff-auth-error" });
    setError("");
  }, [error]);

  const finish = async (sessionId: string | null | undefined) => {
    if (!sessionId || !setActive) throw new Error("Unable to complete sign in");
    await setActive({ session: sessionId });
    router.replace("/");
  };

  const submitSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await signIn.create({ identifier: email.trim() });
      const result = await signIn.attemptFirstFactor({ strategy: "password", password });
      if (result.status === "complete") return await finish(result.createdSessionId);
      if (result.status === "needs_second_factor") {
        setStep("second-factor");
        setNotice("Enter the verification code from your authenticator app.");
        return;
      }
      setError("This account needs another verification step. Use password reset or contact an administrator.");
    } catch (cause) {
      setError(clerkMessage(cause, "Sign in failed. Check your email and password."));
    } finally { setBusy(false); }
  };

  const beginReset = async () => {
    if (!isLoaded || !signIn) return;
    if (!email.trim()) return setError("Enter your work email first.");
    setBusy(true); setError("");
    try {
      await signIn.create({ identifier: email.trim() });
      const resetFactor = signIn.supportedFirstFactors?.find(
        (factor) => factor.strategy === "reset_password_email_code",
      );
      if (!resetFactor || !("emailAddressId" in resetFactor))
        throw new Error("Password recovery is unavailable for this account.");
      await signIn.prepareFirstFactor({
        strategy: "reset_password_email_code",
        emailAddressId: resetFactor.emailAddressId,
      });
    } catch { /* Neutral response prevents account enumeration. */ }
    finally {
      setStep("reset-code");
      setNotice("If this is an eligible staff account, we sent a verification code to its email address.");
      setBusy(false);
    }
  };

  const verifyResetCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn) return;
    setBusy(true); setError("");
    try {
      const result = await signIn.attemptFirstFactor({ strategy: "reset_password_email_code", code: code.trim() });
      if (result.status === "needs_new_password") {
        setStep("new-password"); setNotice("Choose a new password for your staff account."); return;
      }
      setError("That code could not be verified. Request a new code and try again.");
    } catch (cause) { setError(clerkMessage(cause, "That code could not be verified.")); }
    finally { setBusy(false); }
  };

  const verifySecondFactor = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn) return;
    setBusy(true); setError("");
    try {
      const result = await signIn.attemptSecondFactor({ strategy: "totp", code: code.trim() });
      if (result.status === "complete") return await finish(result.createdSessionId);
      setError("That verification code could not be accepted.");
    } catch (cause) { setError(clerkMessage(cause, "That verification code could not be accepted.")); }
    finally { setBusy(false); }
  };

  const savePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!isLoaded || !signIn) return;
    if (newPassword.length < 12) return setError("Choose a password of at least 12 characters.");
    if (newPassword !== confirmPassword) return setError("Passwords do not match.");
    setBusy(true); setError("");
    try {
      const result = await signIn.resetPassword({ password: newPassword, signOutOfOtherSessions: true });
      if (result.status === "complete") return await finish(result.createdSessionId);
      setError("Password updated, but the account needs another verification step.");
    } catch (cause) { setError(clerkMessage(cause, "Unable to update password.")); }
    finally { setBusy(false); }
  };

  const restart = () => { setStep("sign-in"); setPassword(""); setCode(""); setNewPassword(""); setConfirmPassword(""); setError(""); setNotice(""); };

  if (!isLoaded) return <main className="grid min-h-screen place-items-center text-sm text-muted-foreground"><span className="flex items-center gap-2"><Spinner /> Loading secure sign-in…</span></main>;
  return <main className="grid min-h-screen place-items-center bg-background px-4"><section className="w-full max-w-md rounded-xl border bg-card p-8 shadow-card">
    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Visa Compass</p>
    <h1 className="mt-2 text-xl font-semibold tracking-tight">{step === "sign-in" ? "Operations sign in" : step === "second-factor" ? "Verify your identity" : step === "reset-code" ? "Verify your email" : "Set a new password"}</h1>
    <p className="mt-3 text-sm text-muted-foreground">{step === "sign-in" ? "This portal is for invited staff accounts only." : step === "second-factor" ? "Use the code from your configured authenticator app." : "Use the secure recovery code sent to your work email."}</p>
    {notice ? <p className="mt-4 text-sm text-muted-foreground" role="status">{notice}</p> : null}
    {step === "sign-in" ? <form className="mt-6 space-y-4" onSubmit={submitSignIn}><Field label="Work email" id="email" type="email" value={email} onChange={setEmail} autoComplete="email" /><Field label="Password" id="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Signing in…" : "Sign in"}</Button><button className="w-full text-sm text-muted-foreground underline" type="button" onClick={() => void beginReset()} disabled={busy}>Forgot password?</button></form> : step === "second-factor" ? <form className="mt-6 space-y-4" onSubmit={verifySecondFactor}><Field label="Authenticator code" id="authenticator-code" type="text" value={code} onChange={setCode} autoComplete="one-time-code" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Verifying…" : "Verify identity"}</Button></form> : step === "reset-code" ? <form className="mt-6 space-y-4" onSubmit={verifyResetCode}><Field label="Email verification code" id="verification-code" type="text" value={code} onChange={setCode} autoComplete="one-time-code" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Verifying…" : "Verify code"}</Button><button className="w-full text-sm text-muted-foreground underline" type="button" onClick={() => void beginReset()} disabled={busy}>Send a new code</button></form> : <form className="mt-6 space-y-4" onSubmit={savePassword}><Field label="New password" id="new-password" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" /><Field label="Confirm new password" id="confirm-password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Updating…" : "Update password"}</Button></form>}
    {step !== "sign-in" ? <button className="mt-5 text-sm text-muted-foreground underline" type="button" onClick={restart} disabled={busy}>Back to sign in</button> : null}
    <p className="mt-6 text-xs text-muted-foreground">Need a staff account? Ask a Super Admin to send an activation email.</p>
  </section></main>;
}

function Field({ label, id, type, value, onChange, autoComplete }: { label: string; id: string; type: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <label className="block text-sm font-medium" htmlFor={id}>{label}<input id={id} className="mt-2 w-full rounded-md border bg-background px-3 py-2 font-normal" type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} required /></label>;
}
