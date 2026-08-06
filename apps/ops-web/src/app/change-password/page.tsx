"use client";

import { UserProfile } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuthenticatedFetch } from "../authenticated-api-provider";

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
    <section className="panel">
      <div className="top">
        <div>
          <h1>Set a new password</h1>
          <p>
            Your account was provisioned with a temporary password. Set a
            strong new password below, then continue to the console.
          </p>
        </div>
      </div>
      <UserProfile routing="path" path="/change-password" />
      {error && <p className="form-error">{error}</p>}
      <button
        className="primary-action"
        disabled={busy}
        onClick={() => void finish()}
      >
        {busy ? "Continuing…" : "I've set my new password — continue"}
      </button>
    </section>
  );
}
