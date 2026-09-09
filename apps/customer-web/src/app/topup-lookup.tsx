"use client";

import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  MailCheck,
  RefreshCcw,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { formatDataMb, formatPlanDataText } from "../lib/format-data";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { publicApiErrorMessage } from "@visa-compass/shared";

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
  const [verificationRequested, setVerificationRequested] = useState(false);

  const verifyLookup = async (lookupToken: string) => {
    setOpen(true);
    setBusy(true);
    setError("");
    setVerificationRequested(false);
    try {
      const response = await fetch(`${API}/guest/orders/topup-lookup/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lookupToken }),
      });
      const payload = (await response.json()) as {
        data?: LookupResult;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !payload.data)
        throw new Error(
          publicApiErrorMessage(
            payload.error,
            "This recharge link is invalid or expired.",
          ),
        );
      setMobile(payload.data.mobile);
      setResult(payload.data);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}#recharge`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This recharge link is invalid or expired.",
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const lookupToken = new URLSearchParams(window.location.hash.slice(1)).get(
      "topup",
    );
    if (lookupToken) void verifyLookup(lookupToken);
    // The signed token is consumed only on the initial page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setResult(null);
    setAlternatives(null);
    setShowAlternatives(false);
    setVerificationRequested(false);
    setError("");
  };

  const lookup = async () => {
    const entered = mobile.trim();
    const rawDigits = entered.replace(/[^0-9]/g, "");
    const digits = entered.startsWith("00") ? rawDigits.slice(2) : rawDigits;
    if (
      !/^[+0-9][0-9\s()./-]*$/.test(entered) ||
      digits.length < 6 ||
      digits.length > 15
    ) {
      setError("Enter a valid eSIM mobile number with 6 to 15 digits.");
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
        data?: { verificationRequested?: boolean; message?: string };
        error?: { code?: string; message?: string };
      };
      if (!response.ok)
        throw new Error(
          publicApiErrorMessage(
            payload.error,
            "We could not send the recharge link. Please try again.",
          ),
        );
      setVerificationRequested(Boolean(payload.data?.verificationRequested));
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
        error?: { code?: string; message?: string };
      };
      const eligibility = payload.data;
      if (!response.ok || !eligibility?.allowed)
        throw new Error(
          eligibility?.errorMessage ??
            publicApiErrorMessage(
              payload.error,
              "This eSIM cannot subscribe to the selected plan.",
            ),
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
        error?: { code?: string; message?: string };
      };
      if (!response.ok)
        throw new Error(
          publicApiErrorMessage(payload.error, "Plans could not be loaded"),
        );
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
                Keep the eSIM already installed on your phone. Enter its mobile
                number from your delivery email. We will email a secure link
                before showing any eSIM or plan details.
              </p>
              <form
                className="recharge-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void lookup();
                }}
              >
                <label htmlFor="recharge-mobile">eSIM mobile number</label>
                <div className="recharge-control">
                  <span className="recharge-input-icon" aria-hidden="true">
                    <Smartphone size={18} />
                  </span>
                  <input
                    id="recharge-mobile"
                    value={mobile}
                    onChange={(event) => setMobile(event.target.value)}
                    placeholder="e.g. +33 6 12 34 56 78"
                    inputMode="tel"
                    autoComplete="tel"
                    aria-describedby="recharge-help"
                    aria-invalid={Boolean(error && !open)}
                    aria-errormessage={
                      error && !open ? "recharge-error" : undefined
                    }
                    minLength={6}
                    maxLength={24}
                    pattern="[+]?[0-9 ()./-]{6,24}"
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
                Usually 12–15 digits. Spaces and a leading + are accepted.
              </p>
              {error && !open ? (
                <div
                  className="recharge-feedback error"
                  id="recharge-error"
                  role="alert"
                >
                  <AlertCircle size={18} />
                  <span>{error}</span>
                </div>
              ) : null}
              <Link className="recharge-recovery-link" href="/recharge/recover">
                Already paid? Track an existing recharge
              </Link>
            </div>
            <aside className="recharge-note" aria-label="How recharge works">
              <span>No reinstall</span>
              <strong>Your existing eSIM stays on your phone.</strong>
              <p>
                Choose a new data plan, pay securely in NPR, and keep
                travelling.
              </p>
              <div className="recharge-trust-line">
                <ShieldCheck size={16} /> Details are revealed only through the
                private email link.
              </div>
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
                <h2 id="topup-dialog-title">
                  {verificationRequested
                    ? "Request received"
                    : "Your recharge options"}
                </h2>
                <p>
                  {verificationRequested
                    ? "For privacy, this confirmation does not reveal whether the number exists."
                    : "Review the eSIM and choose a compatible plan."}
                </p>
              </div>
            </header>
            {busy && !result ? (
              <div className="topup-loading" role="status" aria-live="polite">
                <LoaderCircle className="spin" size={22} />
                <span>Securely checking your request…</span>
              </div>
            ) : null}

            {result ? (
              <div className="topup-result">
                {result.found && result.subscriber && plan ? (
                  <>
                    <div className="topup-subscriber">
                      <b>{plan.name}</b>
                      <span>
                        {plan.countryName} · {formatPlanDataText(plan.dataAllowance)} ·{" "}
                        {plan.validityDays} days
                      </span>
                      {result.subscriber.usage ? (
                        <small>
                          Used {formatDataMb(result.subscriber.usage.usedMb)} /{" "}
                          {formatDataMb(result.subscriber.usage.totalMb)}
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
                                      {formatPlanDataText(item.dataAllowance)} · {item.validityDays}{" "}
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
                    We could not find a Visa Compass eSIM for this mobile
                    number. Please choose a destination to buy a new eSIM.
                  </p>
                )}
              </div>
            ) : null}
            {verificationRequested ? (
              <div
                className="topup-result topup-email-state"
                role="status"
                aria-live="polite"
              >
                <span className="topup-email-icon" aria-hidden="true">
                  <MailCheck size={24} />
                </span>
                <div>
                  <strong>
                    Check the original purchase email if the number matched
                  </strong>
                  <p>
                    We send a secure link only when the mobile number belongs to
                    an eligible Visa Compass eSIM. The link expires in 15
                    minutes.
                  </p>
                </div>
                <p className="recharge-help">
                  If you do not see it, check spam or confirm that you entered
                  the mobile number from your original delivery email.
                </p>
              </div>
            ) : null}
            {error && open ? (
              <div className="topup-dialog-error" role="alert">
                <AlertCircle size={18} /> <span>{error}</span>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
