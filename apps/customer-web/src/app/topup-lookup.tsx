"use client";
import { useState } from "react";
import { LoaderCircle, RefreshCcw, Search, Smartphone } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

type LookupResult = {
  found: boolean;
  mobile: string;
  subscriber?: {
    currentPlan?: { name: string; dataAllowance: string; validityDays: number; countryCode: string; countryName: string };
    countryCode?: string;
    countryName?: string;
    expiresAt?: string;
    usage?: { usedMb: number; totalMb: number; lastCheckedAt?: string };
    hasActiveEsim: boolean;
  };
  topUpAvailable?: boolean;
};

export default function TopupLookup() {
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | LookupResult>(null);
  const [error, setError] = useState("");

  const lookup = async () => {
    if (!mobile.trim()) {
      setError("Enter the mobile number you used for your last order");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/guest/orders/topup-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobile: mobile.trim() }),
      });
      const payload = (await response.json()) as { data?: unknown; error?: { message: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Lookup failed");
      const value = payload.data as LookupResult;
      setResult(value);
      try {
        if (value?.found && value.topUpAvailable) {
          sessionStorage.setItem("vc_topup_mobile", mobile.trim());
          if (value.subscriber?.countryCode) {
            sessionStorage.setItem("vc_topup_country", value.subscriber.countryCode);
          } else {
            sessionStorage.removeItem("vc_topup_country");
          }
        } else {
          sessionStorage.removeItem("vc_topup_mobile");
          sessionStorage.removeItem("vc_topup_country");
        }
      } catch {
        /* storage unavailable */
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="topup-box">
      <div className="topup-head">
        <Smartphone size={16} />
        <b>Already have a Visa Compass eSIM?</b>
        <small>Enter your mobile number to see your current plan and recharge it.</small>
      </div>
      <div className="topup-row">
        <input
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void lookup()}
          placeholder="e.g. +977 9841 234 567"
          inputMode="tel"
        />
        <button className="button" disabled={busy} onClick={() => void lookup()}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} Check
        </button>
      </div>
      {error && <p className="topup-note error">{error}</p>}
      {result && (
        <div className="topup-result">
          {result.found && result.subscriber ? (
            <>
              <div className="topup-subscriber">
                <b>{result.subscriber.currentPlan?.name ?? "Active subscriber"}</b>
                <span>
                  {result.subscriber.currentPlan
                    ? `${result.subscriber.currentPlan.countryName} · ${result.subscriber.currentPlan.dataAllowance} · ${result.subscriber.currentPlan.validityDays} days`
                    : result.subscriber.countryName ?? "Existing eSIM"}
                </span>
                {result.subscriber.usage && (
                  <small>
                    Used {result.subscriber.usage.usedMb} / {result.subscriber.usage.totalMb} MB
                    {result.subscriber.expiresAt
                      ? ` · valid until ${new Date(result.subscriber.expiresAt).toLocaleDateString()}`
                      : ""}
                  </small>
                )}
              </div>
              {result.topUpAvailable ? (
                <p className="topup-note ok">
                  <RefreshCcw size={14} /> Recharge detected — select this destination below to top up this number.
                </p>
              ) : (
                <p className="topup-note warn">We could not find an active eSIM for this number.</p>
              )}
            </>
          ) : (
            <p className="topup-note warn">
              No prior plan was found for this number. Choose a destination below to start a new eSIM.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
