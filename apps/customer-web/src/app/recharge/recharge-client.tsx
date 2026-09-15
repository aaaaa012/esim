"use client";

import { useAuth } from "@clerk/nextjs";
import { ArrowRight, CheckCircle2, LoaderCircle, RefreshCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import TopupLookup from "../topup-lookup";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Target = { id: string; label: string };

export default function RechargeClient() {
  const { isLoaded, isSignedIn } = useAuth();
  const authFetch = useAuthenticatedFetch();
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setTargets([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void authFetch(`${API}/recharges/targets`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error("Your eSIMs could not be loaded.");
        setTargets(payload.data?.targets ?? []);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("We could not load your eSIMs. Check your connection and try again.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [authFetch, attempt, isLoaded, isSignedIn]);

  return (
    <main className="recharge-page">
      <section className="recharge-page-hero">
        <div className="shell recharge-page-heading">
          <span className="eyebrow"><RefreshCcw size={14} /> Add more data</span>
          <h1>Recharge the right eSIM.</h1>
          <p>
            Choose an eSIM linked to your account, or securely find an existing
            Visa Compass eSIM using the mobile number from its delivery email.
          </p>
        </div>
      </section>

      {loading || !isLoaded ? (
        <div className="shell recharge-route-loading" role="status">
          <LoaderCircle className="spin" size={22} /> Securing your recharge options…
        </div>
      ) : error ? (
        <div className="shell recharge-route-error" role="alert">
          <p>{error}</p>
          <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : isSignedIn ? (
        <section className="section recharge-owned-section" aria-labelledby="owned-recharge-title">
          <div className="shell">
            <div className="recharge-owned-head">
              <span className="recharge-icon" aria-hidden="true"><CheckCircle2 size={21} /></span>
              <div>
                <p className="recharge-kicker">Your account</p>
                <h2 id="owned-recharge-title">
                  {targets.length === 0
                    ? "No rechargeable eSIM is linked yet"
                    : targets.length === 1
                      ? "Recharge your eSIM"
                      : "Which eSIM needs data?"}
                </h2>
                <p>
                  {targets.length === 0
                    ? "Use the secure lookup below, or purchase a new eSIM for your next destination."
                    : "Choose an eSIM you own, then select a destination and plan."}
                </p>
              </div>
            </div>
            {targets.length ? (
              <div className="recharge-targets">
                {targets.map((target) => (
                  <Link
                    className="recharge-target"
                    href={`/destinations?esim=${encodeURIComponent(target.id)}`}
                    key={target.id}
                  >
                    <span><b>{target.label}</b><small>Choose destination and plan</small></span>
                    <ArrowRight size={19} aria-hidden="true" />
                  </Link>
                ))}
              </div>
            ) : (
              <Link className="button secondary recharge-buy-new" href="/destinations">
                Buy a new eSIM <ArrowRight size={17} />
              </Link>
            )}
          </div>
        </section>
      ) : null}

      {!loading && !error ? <TopupLookup /> : null}

    </main>
  );
}
