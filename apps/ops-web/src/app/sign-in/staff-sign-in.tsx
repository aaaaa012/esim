"use client";

import { useAuth, useClerk, useSignIn } from "@clerk/nextjs";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";

type Step = "sign-in" | "second-factor" | "reset-code" | "new-password";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

function clerkMessage(error: unknown, fallback: string) {
  const candidate = error as { errors?: Array<{ longMessage?: string; message?: string }> };
  return candidate?.errors?.[0]?.longMessage ?? candidate?.errors?.[0]?.message ?? fallback;
}

export default function StaffSignIn() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const { isLoaded: authLoaded, isSignedIn, getToken } = useAuth();
  const { signOut } = useClerk();
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [existingAccount, setExistingAccount] = useState<"checking" | "customer" | "staff" | "none">("checking");

  useEffect(() => {
    if (!error) return;
    toast.error(error, { id: "staff-auth-error" });
    setError("");
  }, [error]);

  useEffect(() => {
    if (params.get("activated") === "1")
      setNotice("Your staff account is ready. Sign in with the password you just created.");
  }, [params]);

  useEffect(() => {
    if (!authLoaded) return;
    if (!isSignedIn) {
      setExistingAccount("none");
      return;
    }
    let active = true;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("No session token");
        const response = await fetch(`${API}/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const body = await response.json();
        const accountType = body?.data?.accountType;
        if (!active) return;
        if (["OPERATIONS", "SUPER_ADMIN"].includes(accountType)) {
          setExistingAccount("staff");
          router.replace("/");
          return;
        }
        setExistingAccount("customer");
      } catch {
        if (active) setExistingAccount("customer");
      }
    })();
    return () => { active = false; };
  }, [authLoaded, getToken, isSignedIn, router]);

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
      const resetFactor = signIn.supportedFirstFactors?.find((factor) => factor.strategy === "reset_password_email_code");
      if (!resetFactor || !("emailAddressId" in resetFactor)) throw new Error("Password recovery is unavailable for this account.");
      await signIn.prepareFirstFactor({
        strategy: "reset_password_email_code",
        emailAddressId: resetFactor.emailAddressId,
      });
    } catch {
      // Keep the response neutral so this page cannot reveal whether an account exists.
    } finally {
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
        setStep("new-password");
        setNotice("Choose a new password for your staff account.");
        return;
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

  const restart = () => {
    setStep("sign-in"); setPassword(""); setCode(""); setNewPassword(""); setConfirmPassword(""); setError(""); setNotice("");
  };
  const title = step === "sign-in" ? "Operations sign in" : step === "second-factor" ? "Verify your identity" : step === "reset-code" ? "Verify your email" : "Set a new password";
  const description = step === "sign-in" ? "This portal is for invited staff accounts only." : step === "second-factor" ? "Use the code from your configured authenticator app." : "Use the secure recovery code sent to your work email.";

  if (!isLoaded || !authLoaded || existingAccount === "checking" || existingAccount === "staff")
    return <main className="ops-auth-page"><div className="ops-auth-loader"><Spinner /> Loading secure sign-in</div></main>;

  return (
    <main className="ops-auth-page">
      <div className="ops-auth-shape ops-auth-shape-one" aria-hidden="true" />
      <div className="ops-auth-shape ops-auth-shape-two" aria-hidden="true" />
      <section className="ops-auth-layout">
        <div className="ops-auth-intro">
          <Image src="/brand/visa-compass-services-white.png" alt="Visa Compass Services" width={933} height={373} priority />
          <p>Operations portal</p>
          <h1>Built for the team behind every smooth journey.</h1>
          <span>Restricted access for invited staff and administrators.</span>
        </div>
        <section className="ops-auth-card">
          {existingAccount === "customer" ? <>
            <p className="ops-auth-label">Session check</p>
            <h2>You are already signed in</h2>
            <p>This browser is signed in with a customer or unverified account. Sign out before using an invited staff account.</p>
            <Button className="mt-7 w-full" onClick={() => void signOut({ redirectUrl: "/sign-in" })}>Sign out and use staff account</Button>
          </> : <>
            <p className="ops-auth-label">Visa Compass Operations</p>
            <h2>{title}</h2>
            <p>{description}</p>
            {notice ? <p className="ops-auth-notice" role="status">{notice}</p> : null}
            {step === "sign-in" ? <form className="mt-7 space-y-4" onSubmit={submitSignIn}><Field label="Work email" id="email" type="email" value={email} onChange={setEmail} autoComplete="email" /><Field label="Password" id="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Signing in..." : "Sign in"}</Button><button className="ops-auth-link" type="button" onClick={() => void beginReset()} disabled={busy}>Forgot password?</button></form> : step === "second-factor" ? <form className="mt-7 space-y-4" onSubmit={verifySecondFactor}><Field label="Authenticator code" id="authenticator-code" type="text" value={code} onChange={setCode} autoComplete="one-time-code" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Verifying..." : "Verify identity"}</Button></form> : step === "reset-code" ? <form className="mt-7 space-y-4" onSubmit={verifyResetCode}><Field label="Email verification code" id="verification-code" type="text" value={code} onChange={setCode} autoComplete="one-time-code" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Verifying..." : "Verify code"}</Button><button className="ops-auth-link" type="button" onClick={() => void beginReset()} disabled={busy}>Send a new code</button></form> : <form className="mt-7 space-y-4" onSubmit={savePassword}><Field label="New password" id="new-password" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" /><Field label="Confirm new password" id="confirm-password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" /><Button className="w-full" type="submit" disabled={busy}>{busy ? <Spinner className="text-primary-foreground" /> : null}{busy ? "Updating..." : "Update password"}</Button></form>}
            {step !== "sign-in" ? <button className="ops-auth-link ops-auth-link-left" type="button" onClick={restart} disabled={busy}>Back to sign in</button> : null}
            <p className="ops-auth-footnote">Need a staff account? Ask a Super Admin to send an activation email.</p>
          </>}
        </section>
      </section>
    </main>
  );
}

function Field({ label, id, type, value, onChange, autoComplete }: { label: string; id: string; type: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <label className="ops-auth-field" htmlFor={id}>{label}<input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} required /></label>;
}
