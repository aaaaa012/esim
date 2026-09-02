"use client";

import {
  CheckCircle2,
  LoaderCircle,
  RefreshCcw,
  Search,
  Smartphone,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ErrorModal from "../components/error-modal";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

type Plan = {
  id: string;
  name: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
};
type Country = { code: string; name: string };
type LookupResult = {
  found: boolean;
  mobile: string;
  subscriber?: {
    currentPlan?: Plan & { countryCode: string; countryName: string };
    countryCode?: string;
    countryName?: string;
    expiresAt?: string;
    usage?: { usedMb: number; totalMb: number; lastCheckedAt?: string };
    hasActiveEsim: boolean;
  };
  topUpAvailable?: boolean;
  lookupToken?: string;
};

const npr = (amount: number) => `NPR ${amount.toLocaleString("en-NP")}`;

export default function TopupLookup() {
  const router = useRouter();
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [alternatives, setAlternatives] = useState<Plan[] | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [destination, setDestination] = useState("");
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setResult(null);
    setAlternatives(null);
    setShowAlternatives(false);
    setError("");
  };

  const lookup = async () => {
    if (!mobile.trim()) {
      setError("Enter the mobile number you used for your last order");
      return;
    }
    setOpen(true);
    setBusy(true);
    setError("");
    setResult(null);
    setAlternatives(null);
    setShowAlternatives(false);
    try {
      const response = await fetch(`${API}/guest/orders/topup-lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobile: mobile.trim() }),
      });
      const payload = (await response.json()) as {
        data?: LookupResult;
        error?: { message: string };
      };
      if (!response.ok)
        throw new Error(payload.error?.message ?? "Lookup failed");
      setResult(payload.data ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  const beginRecharge = async (planId: string, planCountry: string) => {
    if (!result?.topUpAvailable || !planCountry) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/guest/orders/topup-eligibility`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mobile: result.mobile || mobile.trim(),
          lookupToken: result.lookupToken,
          planId,
        }),
      });
      const payload = (await response.json()) as {
        data?: { allowed?: boolean; errorMessage?: string };
        error?: { message?: string };
      };
      const eligibility = payload.data;
      if (!response.ok || !eligibility?.allowed)
        throw new Error(
          eligibility?.errorMessage ??
            payload.error?.message ??
            "This eSIM cannot subscribe to the selected plan.",
        );
      const params = new URLSearchParams({
        plan: planId,
        mobile: result.mobile || mobile.trim(),
        lookup: result.lookupToken ?? "",
        country: planCountry,
      });
      router.push(`/esim/checkout?${params.toString()}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not confirm this recharge plan.",
      );
    } finally {
      setBusy(false);
    }
  };

  const loadPlans = async (country: string) => {
    if (!country) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `${API}/public/plans?country=${encodeURIComponent(country)}`,
      );
      const payload = (await response.json()) as {
        data?: Plan[];
        error?: { message: string };
      };
      if (!response.ok)
        throw new Error(payload.error?.message ?? "Plans could not be loaded");
      setAlternatives(payload.data ?? []);
      setShowAlternatives(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Plans could not be loaded",
      );
    } finally {
      setBusy(false);
    }
  };

  const loadAlternatives = async () => {
    const country = result?.subscriber?.countryCode;
    if (!country) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/public/countries`);
      const payload = (await response.json()) as { data?: Country[] };
      if (!response.ok) throw new Error("Destinations could not be loaded");
      setCountries(payload.data ?? []);
      setDestination(country);
      setShowAlternatives(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Destinations could not be loaded",
      );
    } finally {
      setBusy(false);
    }
    await loadPlans(country);
  };

  const plan = result?.subscriber?.currentPlan;
  return (
    <>
      <section
        className="recharge-section"
        id="recharge"
        aria-labelledby="recharge-title"
      >
        <div className="shell">
          <div className="recharge-panel">
            <div className="recharge-marker" aria-hidden="true">
              <span>02</span>
              <i />
              <small>Recharge</small>
            </div>
            <div className="recharge-content">
              <span className="recharge-icon" aria-hidden="true">
                <RefreshCcw size={21} />
              </span>
              <p className="recharge-kicker">For returning travellers</p>
              <h2 id="recharge-title">Add data to your existing eSIM</h2>
              <p className="recharge-description">
                Keep the eSIM already installed on your phone. Enter the mobile
                number from your previous Visa Compass order to find compatible
                recharge plans—no new QR code required.
              </p>
              <form
                className="recharge-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void lookup();
                }}
              >
                <label htmlFor="recharge-mobile">Mobile number</label>
                <div className="recharge-control">
                  <span className="recharge-input-icon" aria-hidden="true">
                    <Smartphone size={18} />
                  </span>
                  <input
                    id="recharge-mobile"
                    value={mobile}
                    onChange={(event) => setMobile(event.target.value)}
                    placeholder="e.g. +977 9841 234 567"
                    inputMode="tel"
                    autoComplete="tel"
                    aria-describedby="recharge-help"
                  />
                </div>
                <button
                  className="button recharge-submit"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <RefreshCcw size={17} />
                  )}
                  Find recharge plans
                </button>
              </form>
              <p className="recharge-help" id="recharge-help">
                Use the same number you entered when purchasing your eSIM.
              </p>
            </div>
            <aside className="recharge-note" aria-label="How recharge works">
              <span>No reinstall</span>
              <strong>Your existing eSIM stays on your phone.</strong>
              <p>
                Choose a new data plan, pay securely in NPR, and keep
                travelling.
              </p>
            </aside>
          </div>
        </div>
      </section>

      {open ? (
        <div
          className="topup-modal-backdrop"
          role="presentation"
          onMouseDown={(event) =>
            event.target === event.currentTarget && close()
          }
        >
          <section
            className="topup-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topup-dialog-title"
          >
            <button
              className="topup-modal-close"
              onClick={close}
              aria-label="Close recharge lookup"
            >
              <X size={19} />
            </button>
            <header className="topup-dialog-heading">
              <span className="topup-dialog-icon">
                <Smartphone size={19} />
              </span>
              <div>
                <h2 id="topup-dialog-title">Top up your eSIM</h2>
                <p>Enter the mobile number linked to your Visa Compass eSIM.</p>
              </div>
            </header>
            <div className="topup-row">
              <input
                autoFocus
                value={mobile}
                onChange={(event) => setMobile(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void lookup()}
                placeholder="e.g. +977 9841 234 567"
                inputMode="tel"
              />
              <button
                className="button"
                disabled={busy}
                onClick={() => void lookup()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Search size={16} />
                )}{" "}
                Check
              </button>
            </div>

            {result ? (
              <div className="topup-result">
                {result.found && result.subscriber && plan ? (
                  <>
                    <div className="topup-subscriber">
                      <b>{plan.name}</b>
                      <span>
                        {plan.countryName} · {plan.dataAllowance} ·{" "}
                        {plan.validityDays} days
                      </span>
                      {result.subscriber.usage ? (
                        <small>
                          Used {result.subscriber.usage.usedMb} /{" "}
                          {result.subscriber.usage.totalMb} MB
                          {result.subscriber.expiresAt
                            ? ` · valid until ${new Date(result.subscriber.expiresAt).toLocaleDateString()}`
                            : ""}
                        </small>
                      ) : null}
                    </div>
                    {result.topUpAvailable ? (
                      <>
                        <p className="topup-note ok">
                          <CheckCircle2 size={15} /> Your eSIM is eligible for
                          recharge.
                        </p>
                        {!showAlternatives ? (
                          <div className="topup-actions">
                            <button
                              className="button"
                              disabled={busy}
                              onClick={() =>
                                void beginRecharge(plan.id, plan.countryCode)
                              }
                            >
                              <RefreshCcw size={16} /> Continue with this plan
                            </button>
                            <button
                              className="button secondary"
                              disabled={busy}
                              onClick={() => void loadAlternatives()}
                            >
                              Choose another {plan.countryName} plan
                            </button>
                          </div>
                        ) : (
                          <div className="topup-alternatives">
                            <label className="topup-destination">
                              <span>Destination</span>
                              <select
                                value={destination}
                                onChange={(event) => {
                                  const next = event.target.value;
                                  setDestination(next);
                                  void loadPlans(next);
                                }}
                              >
                                <option value="">Choose a destination</option>
                                {countries.map((country) => (
                                  <option
                                    key={country.code}
                                    value={country.code}
                                  >
                                    {country.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <p>
                              Choose a plan. We will confirm with Transatel
                              before you can pay.
                            </p>
                            {alternatives?.length ? (
                              alternatives.map((item) => (
                                <div
                                  className="topup-plan-option"
                                  key={item.id}
                                >
                                  <span>
                                    <b>{item.name}</b>
                                    <small>
                                      {item.dataAllowance} · {item.validityDays}{" "}
                                      days · {npr(item.sellingPriceNpr)}
                                    </small>
                                  </span>
                                  <button
                                    className="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void beginRecharge(item.id, destination)
                                    }
                                  >
                                    Select
                                  </button>
                                </div>
                              ))
                            ) : (
                              <p className="topup-note warn">
                                There are no recharge plans available for this
                                destination right now.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="topup-note warn">
                        This eSIM is no longer eligible for recharge. Please
                        choose a new eSIM plan instead.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="topup-note warn">
                    No prior Visa Compass eSIM was found for this mobile number.
                    Please choose a destination to buy a new eSIM.
                  </p>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
      {error ? <ErrorModal error={error} onClose={() => setError("")} /> : null}
    </>
  );
}
