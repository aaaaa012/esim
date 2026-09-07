"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState, type ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import CheckoutClient from "./checkout-client";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Target = { id: string; label: string };
type Resolution = { key: string; targets: Target[]; failed: boolean };

export default function CheckoutEntry(
  props: ComponentProps<typeof CheckoutClient>,
) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const authFetch = useAuthenticatedFetch();
  const explicitCheckout = Boolean(
    props.orderId ||
    props.targetEsimId ||
    props.lookupToken ||
    props.mobile ||
    !props.planId,
  );
  const key = `${userId ?? ""}:${props.planId}`;
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [selection, setSelection] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (explicitCheckout || !isLoaded || !isSignedIn) return;
    let cancelled = false;
    setResolution(null);
    void authFetch(`${API}/recharges/targets`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to check existing eSIMs");
        const payload = await response.json();
        const targets: unknown = payload.data?.targets;
        if (
          !Array.isArray(targets) ||
          targets.some(
            (target) =>
              !target ||
              typeof target.id !== "string" ||
              typeof target.label !== "string",
          )
        )
          throw new Error("Unable to check existing eSIMs");
        if (!cancelled) setResolution({ key, targets, failed: false });
      })
      .catch(() => {
        if (!cancelled) setResolution({ key, targets: [], failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [explicitCheckout, isLoaded, isSignedIn, key, authFetch, attempt]);

  if (explicitCheckout || (isLoaded && !isSignedIn))
    return <CheckoutClient {...props} />;
  const current = resolution?.key === key ? resolution : null;
  if (!isLoaded || !current)
    return (
      <main className="checkout-page">
        <div className="checkout-recovery" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          <p>Checking your existing eSIMs…</p>
        </div>
      </main>
    );
  if (current.failed)
    return (
      <main className="checkout-page">
        <div className="checkout-recovery" role="alert">
          <h1>We couldn’t check your existing eSIMs</h1>
          <p>Try again to continue with the right eSIM for this purchase.</p>
          <button
            className="button"
            onClick={() => {
              setResolution(null);
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  if (!current.targets.length) return <CheckoutClient {...props} />;
  const target =
    current.targets.length === 1
      ? current.targets[0]
      : current.targets.find(
          (item) => selection?.key === key && selection.id === item.id,
        );
  if (target)
    return (
      <CheckoutClient
        {...props}
        targetEsimId={target.id}
        rechargeTargetLabel={target.label}
      />
    );
  return (
    <main className="checkout-page">
      <div className="checkout-shell">
        <section className="checkout-card">
          <div className="form-section">
            <h1>Choose the eSIM to add data to</h1>
            <p>
              Your selected plan will be added to this eSIM. Your traveller
              details and documents are already verified.
            </p>
            <div className="gateway-grid">
              {current.targets.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelection({ key, id: item.id })}
                >
                  <b>{item.label}</b>
                  <small>Add the selected plan</small>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
