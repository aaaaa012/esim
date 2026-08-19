"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useAuth } from "@clerk/nextjs";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, FileCheck2, LoaderCircle, LockKeyhole, QrCode, ShieldCheck, Signal, AlertTriangle, Clock3 } from "lucide-react";
import { flagEmoji } from "../../country-picker";
import DatePicker from "./date-picker";
import {
  DocumentType,
  PaymentProvider,
  apiErrorMessage,
  type PlanSummary,
} from "@visa-compass/shared";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const SIMULATOR = process.env.NEXT_PUBLIC_PAYMENT_MODE === "simulator";
type Envelope<T> = { data: T; error?: { code?: string; message: string } };
type Order = {
  id: string;
  orderNumber: string;
  status: string;
  totalAmountNpr: number;
  plan: PlanSummary;
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  traveler?: Partial<Traveler>;
  documents?: { type: string; status: string }[];
  payment?: { reference: string; status: string };
  passportVerification?: {
    status: string;
    matchedFields?: string[];
    confidence?: number;
    checkedAt?: string;
    method?: string;
    detail?: string;
  };
  documentReviewStatus?: "NOT_STARTED" | "OCR_PENDING" | "OCR_BACKGROUND" | "VERIFIED" | "MANUAL_REVIEW" | "REUPLOAD_REQUIRED" | "MANUALLY_APPROVED" | "SKIPPED";
  provisioningFailure?: { code: string; message: string };
};
type Payment = { reference: string; redirectUrl: string; expiresAt: string };
type DocumentAuthorization = {
  id: string;
  upload: {
    mode: string;
    endpoint?: string;
    apiKey?: string;
    publicId?: string;
    deliveryType?: string;
    timestamp: number;
    signature: string;
    folder: string;
  };
};
type Traveler = {
  title: "MR" | "MS" | "MRS";
  firstName: string;
  middleName: string;
  surname: string;
  dateOfBirth: string;
  nationality: string;
  city: string;
  countryOfResidence: string;
  employerOrBusinessName: string;
  email: string;
  mobile: string;
  passportNumber: string;
  passportExpiryDate: string;
  pointOfSaleCode: string;
};
const initial: Traveler = {
  title: "MR",
  firstName: "",
  middleName: "",
  surname: "",
  dateOfBirth: "",
  nationality: "NP",
  city: "",
  countryOfResidence: "NP",
  employerOrBusinessName: "",
  email: "",
  mobile: "",
  passportNumber: "",
  passportExpiryDate: "",
  pointOfSaleCode: "WEB-NP",
};

export default function CheckoutClient({
  planId,
  orderId,
  mobile,
  lookupToken,
  targetEsimId,
  targetCountry,
}: {
  planId: string;
  orderId: string;
  mobile?: string;
  lookupToken?: string;
  targetEsimId?: string;
  targetCountry?: string;
}) {
  const authFetch = useAuthenticatedFetch();
  const { isLoaded, isSignedIn } = useAuth();
  const tokenKey = (id?: string) => `vc_guest_token_${id || orderId || 'new'}`;
  const readToken = (id?: string) => {
    let t = "";
    try {
      t = sessionStorage.getItem(tokenKey(id)) ?? "";
    } catch {
      t = "";
    }
    if (t) return t;
    try {
      return localStorage.getItem(tokenKey(id)) ?? "";
    } catch {
      return "";
    }
  };
  const [guestToken, setGuestToken] = useState(readToken);
  const guestTokenRef = useRef(guestToken);
  guestTokenRef.current = guestToken;
  const currentToken = () => guestTokenRef.current || readToken();
  const storeGuestToken = (t: string, id: string) => {
    guestTokenRef.current = t;
    setGuestToken(t);
    try {
      sessionStorage.setItem(tokenKey(id), t);
    } catch {
      /* sessionStorage unavailable */
    }
    try {
      localStorage.setItem(tokenKey(id), t);
    } catch {
      /* localStorage unavailable */
    }
  };
  const [guest, setGuest] = useState<boolean>(() => Boolean(readToken()));
  const guestRef = useRef(guest);
  guestRef.current = guest;
  useEffect(() => {
    if (!isLoaded) return;
    const next = isSignedIn !== true;
    setGuest(next);
    guestRef.current = next;
  }, [isLoaded, isSignedIn]);

  const api = async <T,>(path: string, init?: RequestInit) => {
    let url = `${API}${path}`;
    let body = init?.body as BodyInit | null | undefined;
    const isGet = !init?.method || init.method.toUpperCase() === "GET";
    const currentGuest = guestRef.current;
    const toGuest = () => {
      const token = currentToken();
      url = url.replace(`${API}/customer/orders`, `${API}/guest/orders`);
      if (isGet) {
        url += `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
      } else if (typeof body === "string") {
        const parsed = JSON.parse(body);
        parsed.token = token;
        body = JSON.stringify(parsed);
      } else if (!body) {
        body = JSON.stringify({ token });
      }
    };
    const makeInit = () => ({
      ...init,
      ...(body !== undefined ? { body } : {}),
      headers: { "content-type": "application/json", "x-idempotency-key": crypto.randomUUID(), ...init?.headers },
    });
    if (currentGuest) toGuest();
    let response = await authFetch(url, makeInit());
    let payload = (await response.json()) as Envelope<T>;
    if (
      !response.ok &&
      isLoaded && isSignedIn !== true &&
      ["AUTHENTICATION_REQUIRED", "FORBIDDEN"].includes(payload.error?.code ?? "")
    ) {
      toGuest();
      setGuest((g) => {
        const next = g || true;
        guestRef.current = next;
        return next;
      });
      response = await authFetch(url, makeInit());
      payload = (await response.json()) as Envelope<T>;
    }
    if (!response.ok) {
      const error = new Error(apiErrorMessage(payload.error?.code ?? "", payload.error?.message ?? "Something went wrong")) as Error & { code?: string; status?: number };
      if (payload.error?.code) error.code = payload.error.code;
      error.status = response.status;
      throw error;
    }
    return payload.data;
  };

  const [step, setStep] = useState(1),
    [compatible, setCompatible] = useState(false),
    [traveler, setTraveler] = useState(initial);
  const [previewPlan, setPreviewPlan] = useState<PlanSummary | null>(null);
  const [planLoadFailed, setPlanLoadFailed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof Traveler,string>>>({});
  const isTopUpIntent = Boolean((mobile || targetEsimId) && targetCountry && previewPlan?.countryCode === targetCountry) && !orderId;
  useEffect(() => {
    if (!planId || orderId) return;
    let cancelled = false;
    fetch(`${API}/public/plans/${encodeURIComponent(planId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("catalog unavailable"))))
      .then((data: Envelope<PlanSummary>) => {
        if (cancelled) return;
        if (data.data) setPreviewPlan(data.data); else setPlanLoadFailed(true);
      })
      .catch(() => setPlanLoadFailed(true));
    return () => {
      cancelled = true;
    };
  }, [planId, orderId]);
  const [files, setFiles] = useState<{
    passport: File | undefined;
    ticket: File | undefined;
    visa: File | undefined;
  }>({ passport: undefined, ticket: undefined, visa: undefined });
  const [order, setOrder] = useState<Order | null>(null),
    [payment, setPayment] = useState<Payment | null>(null);
  const verifyRunToken = useRef(0);
  useEffect(() => () => { verifyRunToken.current += 1; }, []);
  const summaryPlan = order?.plan ?? previewPlan;
  const isTopUp = order?.purchaseType === "TOPUP" || isTopUpIntent;
  const [provider, setProvider] = useState<PaymentProvider>(
      PaymentProvider.KHALTI,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [verifying, setVerifying] = useState(false);
  const [verifyingPassport, setVerifyingPassport] = useState(false);
  useEffect(() => {
    if (!isTopUpIntent) return;
    setCompatible(true);
    setStep(4);
  }, [isTopUpIntent]);
  useEffect(() => {
    if (!orderId) return;
    if (!isLoaded && !guestToken) return;
    setBusy(true);
    api<Order>(`/customer/orders/${orderId}`)
      .then((value) => {
        if (!["DRAFT", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(value.status))
          throw new Error("This order can no longer be resumed from checkout");
        setOrder(value);
        setCompatible(true);
        if (value.traveler) setTraveler({ ...initial, ...value.traveler });
        if (value.purchaseType === "TOPUP") {
          setStep(4);
          if (value.status === "PAYMENT_PENDING" && value.payment) {
            setPayment({ reference: value.payment.reference, redirectUrl: "", expiresAt: "" });
            void verifyPayment(value);
          }
          return;
        }
        const hasRequiredDocs = Boolean(
          value.documents?.some((document) => document.type === "PASSPORT") &&
          value.documents?.some((document) => document.type === "TICKET"),
        );
        if (value.status === "PAYMENT_PENDING" && value.payment) {
          setPayment({
            reference: value.payment.reference,
            redirectUrl: "",
            expiresAt: "",
          });
          setStep(4);
          void verifyPayment(value);
        } else if (value.status === "PAYMENT_FAILED") {
          setPayment(null);
          setStep(4);
        } else if (!value.traveler) setStep(2);
        else if (!hasRequiredDocs) setStep(3);
        else setStep(4);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Order could not be resumed",
        ),
      )
      .finally(() => setBusy(false));
  }, [orderId, isLoaded, guestToken]);
  const VERIFY_DELAYS = [0, 2_000, 4_000, 7_000, 10_000, 15_000, 20_000, 30_000, 45_000];
  const VERIFY_BUDGET_MS = 120_000;
  const TERMINAL_STATUSES = ["PAYMENT_CONFIRMED", "REVIEW_PENDING", "APPROVED", "PROVISIONING", "QR_READY", "COMPLETED", "PAYMENT_FAILED", "PROVISIONING_FAILED", "CANCELLED"];
  const stripReturnParams = () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!["reference", "pidx", "simulated"].some((key) => url.searchParams.has(key))) return;
    for (const key of ["reference", "pidx", "simulated", "status", "purchase_order_id", "transaction_id", "amount"]) url.searchParams.delete(key);
    window.history.replaceState({}, "", url.toString());
  };
  const verifyPayment = async (initialOrder: Order) => {
    const token = ++verifyRunToken.current;
    setVerifying(true);
    setError("");
    stripReturnParams();
    const started = Date.now();
    let current = initialOrder;
    let attempt = 0;
    while (Date.now() - started < VERIFY_BUDGET_MS) {
      if (verifyRunToken.current !== token) return;
      const wait = VERIFY_DELAYS[Math.min(attempt, VERIFY_DELAYS.length - 1)] ?? 0;
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (verifyRunToken.current !== token) return;
      }
      attempt += 1;
      try {
        // Retry the verification lookup itself (not just the order poll):
        // Khalti can report pending/initiated for a few seconds after the
        // wallet redirect, so a single attempt is not enough.
        const updated = await api<Order>(`/customer/orders/${current.id}/payment/verify`, {
          method: "POST",
          body: JSON.stringify({ reference: current.payment?.reference }),
        });
        setOrder(updated);
        current = updated;
        if (TERMINAL_STATUSES.includes(updated.status)) {
          setVerifying(false);
          return;
        }
      } catch (cause) {
        const code = (cause as { code?: string })?.code;
        if (code === "PAYMENT_EXPIRED" || code === "PAYMENT_REFERENCE_MISMATCH" || code === "PAYMENT_NOT_CONFIRMED") {
          const refreshed = await api<Order>(`/customer/orders/${current.id}`).catch(() => current);
          setOrder(refreshed);
          current = refreshed;
          setVerifying(false);
          return;
        }
        // Transient network/provider errors retry; refresh the order so the
        // UI stays current without treating an unknown error as "pending".
        const refreshed = await api<Order>(`/customer/orders/${current.id}`).catch(() => current);
        setOrder(refreshed);
        current = refreshed;
        if (TERMINAL_STATUSES.includes(refreshed.status)) {
          setVerifying(false);
          return;
        }
      }
    }
    setOrder(await api<Order>(`/customer/orders/${current.id}`).catch(() => current));
    setError("Your payment is still being confirmed. Check your eSIMs shortly.");
    setVerifying(false);
  };
  const update = (key: keyof Traveler, value: string) =>
    { setTraveler((v) => ({ ...v, [key]: value })); setFieldErrors((current) => ({ ...current, [key]: undefined })); };
  const verifyPassport = async (): Promise<Order | null> => {
    if (!order || verifyingPassport) return order;
    setVerifyingPassport(true);
    setError("");
    try {
      let updated = await api<Order>(`/customer/orders/${order.id}/verify-passport`, { method: "POST", body: "{}" });
      const deadline = Date.now() + 8_500;
      while (updated.documentReviewStatus === "OCR_PENDING" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        updated = await api<Order>(`/customer/orders/${order.id}`);
      }
      if (updated.documentReviewStatus === "OCR_PENDING")
        updated = await api<Order>(`/customer/orders/${order.id}/verify-passport`, { method: "POST", body: "{}" });
      setOrder(updated);
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not verify your passport");
      return null;
    } finally {
      setVerifyingPassport(false);
    }
  };
  const passportGatePassed = (target: Order | null) =>
    !target || isTopUp || ["VERIFIED", "MANUAL_REVIEW", "MANUALLY_APPROVED", "SKIPPED", "OCR_BACKGROUND"].includes(target.documentReviewStatus ?? "") || target.passportVerification?.status === "VERIFIED" || target.passportVerification?.status === "SKIPPED";
  useEffect(() => {
    if (step !== 4 || isTopUp) return;
    if (!order || order.passportVerification) return;
    if (!order.documents?.some((document) => document.type === "PASSPORT")) return;
    void verifyPassport();
  }, [step, order?.id, isTopUp]);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  const begin = () =>
    run(async () => {
      if (order) {
        if (isTopUp) {
          setStep(4);
          return;
        }
        setStep(order.traveler ? 3 : 2);
        return;
      }
      if (!isLoaded) throw new Error("Finishing secure sign-in. Please try again in a moment.");
      if (!planId) throw new Error("Choose a plan before checkout");
      if (!compatible && !isTopUpIntent) throw new Error("Confirm device compatibility");
      if (guest) {
        const created = await api<{ order: Order; token: string }>("/customer/orders", {
          method: "POST",
          body: JSON.stringify({
            planId,
            compatibilityAccepted: true,
            mobile: (mobile || traveler.mobile) || undefined,
            lookupToken: lookupToken || undefined,
          }),
        });
        setOrder(created.order);
        storeGuestToken(created.token, created.order.id);
        if (created.order.purchaseType === "TOPUP") {
          setStep(4);
          await initiate(created.order);
        } else {
          setStep(2);
        }
        return;
      }
      const payload: { order: Order; token: string } | Order = await api<
        { order: Order; token: string } | Order
      >("/customer/orders", {
        method: "POST",
        body: JSON.stringify({ planId, compatibilityAccepted: true, ...(targetEsimId ? { targetEsimId } : {}) }),
      });
      const isGuestPayload =
        typeof payload === "object" && payload !== null && "order" in payload && "token" in payload;
      const finalOrder: Order = isGuestPayload
        ? (payload as { order: Order }).order
        : (payload as Order);
      setOrder(finalOrder);
      if (finalOrder.traveler) setTraveler({ ...initial, ...finalOrder.traveler });
      if (isGuestPayload) {
        storeGuestToken((payload as { token: string }).token, finalOrder.id);
      }
      if (finalOrder.purchaseType === "TOPUP") {
        setStep(4);
        await initiate(finalOrder);
      } else {
        setStep(2);
      }
    });
  const saveTraveler = () =>
    run(async () => {
      if (!order) return;
      const required: [keyof Traveler, string][] = [
        ["firstName", "First name"],
        ["surname", "Surname"],
        ["dateOfBirth", "Date of birth"],
        ["passportNumber", "Passport number"],
        ["passportExpiryDate", "Passport expiry"],
        ["city", "City / district"],
        ["nationality", "Nationality"],
        ["countryOfResidence", "Country of residence"],
        ["email", "Email"],
        ["mobile", "Mobile / WhatsApp"],
      ];
      const nextErrors: Partial<Record<keyof Traveler,string>> = {};
      for (const [key,label] of required) if (!traveler[key].trim()) nextErrors[key]=`${label} is required`;
      if (traveler.email && !/^\S+@\S+\.\S+$/.test(traveler.email)) nextErrors.email="Enter a valid email address";
      if (traveler.mobile && !/^\+?[0-9][0-9\s-]{6,19}$/.test(traveler.mobile)) nextErrors.mobile="Enter a valid mobile number";
      if (traveler.passportNumber && traveler.passportNumber.length < 5) nextErrors.passportNumber="Passport number must be at least 5 characters";
      if (traveler.dateOfBirth && new Date(traveler.dateOfBirth) >= new Date()) nextErrors.dateOfBirth="Date of birth must be in the past";
      if (traveler.passportExpiryDate && new Date(traveler.passportExpiryDate) <= new Date()) nextErrors.passportExpiryDate="Passport must not be expired";
      setFieldErrors(nextErrors);
      const firstError = Object.keys(nextErrors)[0];
      if (firstError) { document.querySelector<HTMLElement>(`[name="${firstError}"]`)?.focus(); throw new Error("Check the highlighted traveller details"); }
      if (
        traveler.nationality.length !== 2 ||
        traveler.countryOfResidence.length !== 2
      )
        throw new Error(
          "Nationality and country of residence must use two-letter country codes",
        );
      const body = Object.fromEntries(
        Object.entries(traveler).filter(([, v]) => v !== ""),
      );
      await api(`/customer/orders/${order.id}/traveler`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setOrder((o) =>
        o && ["FAILED", "PARTIAL"].includes(o.passportVerification?.status ?? "")
          ? (({ passportVerification: _drop, ...rest }) => rest)(o)
          : o,
      );
      setStep(3);
    });
  const saveDocuments = () =>
    run(async () => {
      if (!order || !files.passport || !files.ticket)
        throw new Error("Passport and travel ticket are required");
      for (const [key, file] of Object.entries(files)) {
        if (!file) continue;
        if (file.size > 10 * 1024 * 1024)
          throw new Error(`${file.name} exceeds the 10 MB limit`);
        const type =
          key === "passport"
            ? DocumentType.PASSPORT
            : key === "ticket"
              ? DocumentType.TICKET
              : DocumentType.VISA;
        const authorization = await api<DocumentAuthorization>(
          `/customer/orders/${order.id}/documents`,
          {
            method: "POST",
            body: JSON.stringify({
              type,
              fileName: file.name,
              contentType: file.type || "application/pdf",
            }),
          },
        );
        if (authorization.upload.mode === "local-simulator") {
          await api(
            `/customer/orders/${order.id}/documents/${authorization.id}/confirm`,
            { method: "POST", body: "{}" },
          );
          continue;
        }
        if (
          authorization.upload.mode !== "cloudinary-signed" ||
          !authorization.upload.endpoint
        )
          throw new Error("Private document storage is unavailable");
        const form = new FormData();
        form.append("file", file);
        form.append("api_key", authorization.upload.apiKey!);
        form.append("timestamp", String(authorization.upload.timestamp));
        form.append("signature", authorization.upload.signature);
        form.append("folder", authorization.upload.folder);
        form.append("public_id", authorization.upload.publicId!);
        form.append("type", authorization.upload.deliveryType!);
        const uploaded = await authFetch(authorization.upload.endpoint, {
          method: "POST",
          body: form,
        });
        if (!uploaded.ok) throw new Error(`Upload failed for ${file.name}`);
        await api(
          `/customer/orders/${order.id}/documents/${authorization.id}/confirm`,
          { method: "POST", body: "{}" },
        );
      }
      setOrder(await api<Order>(`/customer/orders/${order.id}`));
      setStep(4);
    });
  const initiate = (orderArg?: Order) =>
    run(async () => {
      let target = orderArg ?? order;
      if (target) {
        let verification = target.passportVerification;
        if (!isTopUp && (verification?.status === "FAILED" || verification?.status === "PARTIAL")) {
          throw new Error("We couldn't verify your passport against your traveller details. Review your details and re-check your passport before paying.");
        }
        if (!isTopUp && !passportGatePassed(target)) {
          const updated = await verifyPassport();
          if (!updated) return;
          target = updated;
          verification = updated.passportVerification;
        }
        if (!isTopUp && !passportGatePassed(target)) {
          throw new Error("Verify your passport before continuing to payment.");
        }
        const value = await api<Payment>(`/customer/orders/${target.id}/payment`, {
          method: "POST",
          body: JSON.stringify({ provider }),
        });
        setPayment(value);
        const external = (url: string) => {
          try {
            return new URL(url).origin !== window.location.origin;
          } catch {
            return true;
          }
        };
        if (value.redirectUrl && external(value.redirectUrl))
          window.location.assign(value.redirectUrl);
      }
    });
  const complete = () =>
    run(async () => {
      if (!order || !payment) return;
      if (SIMULATOR) {
        const endpoint = guest
          ? `/customer/orders/${order.id}/payment/simulate`
          : `/customer/orders/${order.id}/payment/simulate-complete`;
        setOrder(
          await api<Order>(
            endpoint,
            {
              method: "POST",
              body: JSON.stringify({ reference: payment.reference }),
            },
          ),
        );
        return;
      }
      void verifyPayment(order);
    });

  if ((!planId && !orderId) || planLoadFailed) return <main className="checkout-page"><div className="checkout-recovery"><QrCode/><h1>We could not load this checkout</h1><p>The plan link may be incomplete or no longer available.</p><div><Link className="button" href="/#plans">Choose a plan</Link>{isSignedIn === true && <Link className="button secondary" href="/account/orders">Order history</Link>}</div></div></main>;
  return (
    <main className="checkout-page">
      <div className="checkout-shell">
        <div className="checkout-heading">
          <Link href="/" className="back-link">
            <ChevronLeft size={16} /> Plans
          </Link>
          <span className="eyebrow">
            <LockKeyhole size={13} />
            Secure checkout
          </span>
          <h1>{isTopUp ? "Top up your eSIM" : "Your travel eSIM"}</h1>
          <p>
            {isTopUp
              ? "Recharge your existing eSIM. No verification needed. Pay and activate in seconds."
              : "Complete verification once. We’ll keep your order safe while our team reviews it."}
          </p>
        </div>
        <div className="checkout-progress">
          <span style={{ width: `${(isTopUp ? 1 : step * 0.25) * 100}%` }} />
        </div>
        <div className="checkout-layout">
          <section className="checkout-card">
            <div className="step-tabs">
              {(isTopUp ? ["Payment"] : ["Compatibility", "Traveller", "Documents", "Payment"]).map(
                (label, index) => (
                  <div
                    key={label}
                    className={
                      step === index + 1
                        ? "active"
                        : step > index + 1
                          ? "done"
                          : ""
                    }
                  >
                    <i>{step > index + 1 ? <Check size={13} /> : index + 1}</i>
                    <span>{label}</span>
                  </div>
                ),
              )}
            </div>
            {error && <div className="form-error">{error}</div>}
            {step === 1 && (
              <div className="form-section">
                <span className="form-icon">
                  <ShieldCheck />
                </span>
                <h2>Confirm your device</h2>
                <p>
                  Your phone must support eSIM and be carrier-unlocked. Coverage
                  starts after first connection at your destination.
                </p>
                <label className="confirm-box">
                  <input
                    type="checkbox"
                    checked={compatible}
                    onChange={(e) => setCompatible(e.target.checked)}
                  />
                  <span>
                    <b>I confirm my device is compatible</b>
                    <small>
                      I understand incompatible devices are not eligible for a
                      refund.
                    </small>
                  </span>
                </label>
                <Action busy={busy} onClick={begin}>
                  Continue
                </Action>
              </div>
            )}
            {step === 2 && (
              <div className="form-section">
                <h2>Traveller information</h2>
                <p>
                  Enter details exactly as shown on the passport. Use two-letter
                  country codes.
                </p>
                <div className="form-grid">
                  <Field label="Title">
                    <select
                      value={traveler.title}
                      onChange={(e) => update("title", e.target.value)}
                    >
                      <option>MR</option>
                      <option>MS</option>
                      <option>MRS</option>
                    </select>
                  </Field>
                  <Field label="First name" error={fieldErrors.firstName}>
                    <input
                      name="firstName" autoComplete="given-name"
                      value={traveler.firstName}
                      onChange={(e) => update("firstName", e.target.value)}
                    />
                  </Field>
                  <Field label="Middle name (optional)">
                    <input
                      value={traveler.middleName}
                      onChange={(e) => update("middleName", e.target.value)}
                    />
                  </Field>
                  <Field label="Surname" error={fieldErrors.surname}>
                    <input
                      name="surname" autoComplete="family-name"
                      value={traveler.surname}
                      onChange={(e) => update("surname", e.target.value)}
                    />
                  </Field>
                  <Field label="Date of birth" error={fieldErrors.dateOfBirth}>
                    <DatePicker
                      name="dateOfBirth"
                      value={traveler.dateOfBirth}
                      max={new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}
                      placeholder="Choose date of birth"
                      onChange={(value) => update("dateOfBirth", value)}
                    />
                  </Field>
                  <Field label="Passport number" error={fieldErrors.passportNumber}>
                    <input
                      name="passportNumber"
                      value={traveler.passportNumber}
                      onChange={(e) =>
                        update("passportNumber", e.target.value.toUpperCase())
                      }
                    />
                  </Field>
                  <Field label="Passport expiry" error={fieldErrors.passportExpiryDate}>
                    <DatePicker
                      name="passportExpiryDate"
                      value={traveler.passportExpiryDate}
                      min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
                      placeholder="Choose passport expiry"
                      onChange={(value) => update("passportExpiryDate", value)}
                    />
                  </Field>
                  <Field label="Nationality" error={fieldErrors.nationality}>
                    <input
                      name="nationality" placeholder="NP" list="country-codes"
                      maxLength={2}
                      value={traveler.nationality}
                      onChange={(e) =>
                        update("nationality", e.target.value.toUpperCase())
                      }
                    />
                  </Field>
                  <Field label="City / district" error={fieldErrors.city}>
                    <input
                      name="city" autoComplete="address-level2"
                      value={traveler.city}
                      onChange={(e) => update("city", e.target.value)}
                    />
                  </Field>
                  <Field label="Country of residence" error={fieldErrors.countryOfResidence}>
                    <input
                      name="countryOfResidence" placeholder="NP" list="country-codes" autoComplete="country"
                      maxLength={2}
                      value={traveler.countryOfResidence}
                      onChange={(e) =>
                        update(
                          "countryOfResidence",
                          e.target.value.toUpperCase(),
                        )
                      }
                    />
                  </Field>
                  <Field label="Email" error={fieldErrors.email}>
                    <input
                      name="email" autoComplete="email"
                      type="email"
                      value={traveler.email}
                      onChange={(e) => update("email", e.target.value)}
                    />
                  </Field>
                  <Field label="Mobile / WhatsApp" error={fieldErrors.mobile}>
                    <input
                      name="mobile" inputMode="tel" autoComplete="tel"
                      value={traveler.mobile}
                      onChange={(e) => update("mobile", e.target.value)}
                    />
                  </Field>
                  <Field label="Employer / business (optional)" full>
                    <input
                      value={traveler.employerOrBusinessName}
                      onChange={(e) =>
                        update("employerOrBusinessName", e.target.value)
                      }
                    />
                  </Field>
                </div>
                <datalist id="country-codes"><option value="NP">Nepal</option><option value="IN">India</option><option value="US">United States</option><option value="GB">United Kingdom</option><option value="AU">Australia</option><option value="CA">Canada</option><option value="AE">United Arab Emirates</option><option value="JP">Japan</option><option value="KR">South Korea</option></datalist>
                <Nav back={() => setStep(1)} busy={busy} next={saveTraveler} />
              </div>
            )}
            {step === 3 && (
              <div className="form-section">
                <span className="form-icon">
                  <FileCheck2 />
                </span>
                <h2>Travel documents</h2>
                <p>
                  PDF, JPG or PNG. Upload authorization is private and
                  short-lived.
                </p>
                <div className="upload-list">
                  <FileField
                    label="Passport"
                    file={files.passport}
                    onChange={(v) => setFiles((f) => ({ ...f, passport: v }))}
                    capture
                  />
                  <FileField
                    label="Travel ticket"
                    file={files.ticket}
                    onChange={(v) => setFiles((f) => ({ ...f, ticket: v }))}
                    capture
                  />
                  <FileField
                    label="Visa (optional)"
                    file={files.visa}
                    onChange={(v) => setFiles((f) => ({ ...f, visa: v }))}
                    capture
                  />
                </div>
                <Nav back={() => setStep(2)} busy={busy} next={saveDocuments} />
              </div>
            )}
            {step === 4 && (
              <div className="form-section">
                <h2>
                  {order &&
                  ["PAYMENT_CONFIRMED", "REVIEW_PENDING", "APPROVED", "PROVISIONING", "QR_READY", "COMPLETED"].includes(
                    order.status,
                  )
                    ? "Payment verified"
                    : order &&
                        ["PAYMENT_FAILED", "PROVISIONING_FAILED", "CANCELLED"].includes(
                          order.status,
                        )
                      ? "Payment issue"
                      : "Choose payment method"}
                </h2>
                {order?.status === "QR_READY" ? (
                  <div className="success-panel">
                    <QrCode size={42} />
                    <b>Your activation QR has been sent</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      Install your eSIM using the QR emailed to you as a
                      password-protected PDF, then connect to the network once to
                      activate it. Your order will complete automatically.
                    </p>
                    {isSignedIn === true && (
                      <>
                        <Link className="button" href="/account/esims">
                          View my eSIMs
                        </Link>
                        <Link className="button" href={`/account/esims/${order.id}`}>
                          Didn&apos;t get the QR? Recover it
                        </Link>
                      </>
                    )}
                  </div>
                ) : order?.status === "COMPLETED" ? (
                  <div className="success-panel">
                    <CheckCircle2 size={42} />
                    <b>Your eSIM is ready</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      Your activation QR was emailed to you as a password-protected
                      PDF. Open it on your phone and enter the mobile number shown
                      in your email to reveal the QR.
                    </p>
                    {isSignedIn === true && (
                      <>
                        <Link className="button" href="/account/esims">
                          View my eSIMs
                        </Link>
                        <Link className="button" href={`/account/esims/${order.id}`}>
                          Didn&apos;t get the QR? Recover it
                        </Link>
                      </>
                    )}
                  </div>
                ) : order && order.status === "PROVISIONING_FAILED" ? (
                  <div className="error-panel">
                    <AlertTriangle size={42} />
                    <b>We could not activate your eSIM</b>
                    <span>{order.orderNumber}</span>
                    <p>{order.provisioningFailure?.message ?? "We could not activate your eSIM right now. Our team is reviewing it and will contact you."}</p>
                    <Link className="button" href="/#plans">
                      Choose another plan
                    </Link>
                    {isSignedIn === true && (
                      <Link className="button secondary" href={`/account/esims/${order.id}`}>
                        Check status
                      </Link>
                    )}
                  </div>
                ) : order &&
                  ["PAYMENT_CONFIRMED", "REVIEW_PENDING", "APPROVED", "PROVISIONING"].includes(
                    order.status,
                  ) ? (
                  <div className="success-panel">
                    <LoaderCircle className="spin" size={42} />
                    <b>Payment verified. Activating your eSIM</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      Your eSIM is being activated automatically. Your QR will be
                      emailed to you as a password-protected PDF shortly.
                    </p>
                    {isSignedIn === true && (
                      <Link className="button" href="/account/esims">
                        View my eSIMs
                      </Link>
                    )}
                  </div>
                ) : verifying ? (
                  <div className="success-panel">
                    <LoaderCircle className="spin" size={42} />
                    <b>Checking payment status</b>
                    <span>{order?.orderNumber}</span>
                    <p>
                      We are checking with Khalti. Your order will only be marked
                      as paid after the gateway confirms the transaction.
                    </p>
                  </div>
                ) : (
                  <>
                    {order && !isTopUp && (
                      <PassportCheck
                        result={order.passportVerification}
                        reviewStatus={order.documentReviewStatus}
                        {...(order.payment?.status ? { paymentStatus: order.payment.status } : {})}
                        busy={verifyingPassport}
                        onRecheck={() => void verifyPassport()}
                        onEdit={() => setStep(2)}
                      />
                    )}
                    {order &&
                      ["PAYMENT_FAILED", "PROVISIONING_FAILED", "CANCELLED"].includes(
                        order.status,
                      ) && (
                        <p>
                          Your earlier payment could not be confirmed. You can try
                          again below.
                        </p>
                      )}
                    <p>
                      The server checks the exact order, reference and immutable
                      NPR amount.
                    </p>
                    <div className="gateway-grid">
                      <button className="selected">
                        <b>Khalti</b>
                        <small>Digital wallet</small>
                      </button>
                    </div>
                    {payment ? (
                      SIMULATOR ? (
                        <div className="simulator-box">
                          <span>Local signed simulator</span>
                          <small>
                            Reference: {payment.reference.slice(0, 14)}...
                          </small>
                          <Action busy={busy} disabled={verifyingPassport || !passportGatePassed(order)} onClick={complete}>
                            Simulate verified payment
                          </Action>
                        </div>
                      ) : (
                        <Action busy={busy} disabled={verifyingPassport || !passportGatePassed(order)} onClick={complete}>
                          Check payment status
                        </Action>
                      )
                    ) : isTopUp && !order ? (
                      <Action busy={busy} onClick={begin}>
                        Continue to payment
                      </Action>
                    ) : (
                      <Action busy={busy} disabled={verifyingPassport || !passportGatePassed(order)} onClick={() => void initiate()}>
                        Continue to Khalti
                      </Action>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
          <aside className="order-summary">
            <div className="summary-plan">
              <span className="summary-flag">
                {summaryPlan ? flagEmoji(summaryPlan.countryCode) : <Signal size={22} />}
              </span>
              <span className="summary-plan-info">
                <span className="summary-label">Order summary</span>
                <b>{summaryPlan?.name ?? "Selected eSIM plan"}</b>
                <small>
                  {summaryPlan ? `${summaryPlan.countryCode} · ${summaryPlan.dataAllowance}` : "Loaded securely"}
                </small>
              </span>
            </div>
            <div>
              <small>Destination</small>
              <b>{summaryPlan?.countryCode ?? "Not selected"}</b>
            </div>
            <div>
              <small>Data & validity</small>
              <b>
                {summaryPlan ? `${summaryPlan.dataAllowance} · ${summaryPlan.validityDays} days` : "Loaded securely"}
              </b>
            </div>
            <div className="summary-total">
              <small>Total</small>
              <b>NPR {(order?.totalAmountNpr ?? summaryPlan?.sellingPriceNpr ?? 0).toLocaleString()}</b>
            </div>
            <p>
              <LockKeyhole size={14} /> Price is frozen when your order is
              created.
            </p>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  full,
  error,
  children,
}: {
  label: string;
  full?: boolean;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className={`${full ? "full " : ""}${error ? "field-invalid" : ""}`}>
      {label}
      {children}
      {error&&<small className="field-error">{error}</small>}
    </label>
  );
}
function Action({
  busy,
  onClick,
  children,
  disabled,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button className="button wide" disabled={busy || disabled} onClick={onClick}>
      {busy ? (
        <LoaderCircle className="spin" size={18} />
      ) : (
        <>
          {children}
          <ChevronRight size={18} />
        </>
      )}
    </button>
  );
}

const FIELD_LABELS: Record<string, string> = {
  passportNumber: "Passport number",
  surname: "Surname",
  givenNames: "Given name(s)",
  dateOfBirth: "Date of birth",
  passportExpiryDate: "Passport expiry",
};

function PassportCheck({
  result,
  reviewStatus,
  paymentStatus,
  busy,
  onRecheck,
  onEdit,
}: {
  result: Order["passportVerification"];
  reviewStatus?: Order["documentReviewStatus"];
  paymentStatus?: string;
  busy: boolean;
  onRecheck: () => void;
  onEdit?: () => void;
}) {
  const status = result?.status;
  const paymentLabel = paymentStatus === "PENDING"
    ? "Payment awaiting confirmation"
    : paymentStatus === "FAILED"
      ? "No confirmed payment"
      : "Payment not started";
  if (reviewStatus === "OCR_BACKGROUND") {
    return (
      <div className="passport-check background" role="status">
        <Clock3 size={20} />
        <span>
          <b>Document check continuing in the background</b>
          <small>
            You can continue to Khalti now. Verification is separate from payment,
            and we will contact you only if a clearer document is needed.
          </small>
        </span>
        <span className="passport-check-tag">{paymentLabel}</span>
      </div>
    );
  }
  if (reviewStatus === "MANUAL_REVIEW") {
    return (
      <div className="passport-check manual" role="status">
        <ShieldCheck size={20} />
        <span>
          <b>Documents saved for review</b>
          <small>
            You can continue to payment. Our team will review the documents
            separately, without delaying eSIM activation after payment.
          </small>
        </span>
        <span className="passport-check-tag">{paymentLabel}</span>
      </div>
    );
  }
  if (reviewStatus === "REUPLOAD_REQUIRED") {
    return (
      <div className="passport-check failed">
        <AlertTriangle size={20} />
        <span>
          <b>A clearer passport image is needed</b>
          <small>
            We could not match the uploaded passport reliably. Replace it with a
            sharp image of the information page before continuing.
          </small>
        </span>
        {onEdit && <button className="button secondary" onClick={onEdit}>Replace document</button>}
      </div>
    );
  }
  if (status === "VERIFIED") {
    return (
      <div className="passport-check verified">
        <CheckCircle2 size={20} />
        <span>
          <b>Passport verified</b>
          <small>
            We matched your passport against your traveller details before
            payment.
          </small>
        </span>
      </div>
    );
  }
  if (status === "SKIPPED") {
    return (
      <div className="passport-check skipped">
        <ShieldCheck size={20} />
        <span>
          <b>Passport check skipped</b>
          <small>Document verification is disabled in this environment.</small>
        </span>
      </div>
    );
  }
  if (busy) {
    return (
      <div className="passport-check checking">
        <LoaderCircle className="spin" size={20} />
        <span>
          <b>Verifying your passport</b>
          <small>
            Reading the document and comparing it with your traveller details.
          </small>
        </span>
      </div>
    );
  }
  if (status === "PARTIAL") {
    return (
      <div className="passport-check warning">
        <AlertTriangle size={20} />
        <span>
          <b>Passport number matched</b>
          <small>
            We found your passport number but couldn&apos;t confirm the name or
            dates. Check your traveller details or try a clearer photo, then
            re-check.
          </small>
        </span>
        {onEdit && (
          <button className="button secondary" onClick={onEdit}>
            Edit traveller details
          </button>
        )}
        <button className="button secondary" onClick={onRecheck}>
          Re-check
        </button>
      </div>
    );
  }
  if (status === "FAILED") {
    return (
      <div className="passport-check failed">
        <AlertTriangle size={20} />
        <span>
          <b>We couldn&apos;t verify your passport</b>
          <small>
            The photo wasn&apos;t clear enough to read. Please re-upload a
            sharp, well-lit photo of the passport information page showing all
            details, then re-check.
          </small>
        </span>
        {onEdit && (
          <button className="button secondary" onClick={onEdit}>
            Edit traveller details
          </button>
        )}
        <button className="button secondary" onClick={onRecheck}>
          Re-check
        </button>
      </div>
    );
  }
  return (
    <div className="passport-check">
      <ShieldCheck size={20} />
      <span>
        <b>Verify your passport</b>
        <small>
          We read your passport and compare it with your traveller details
          before payment.
        </small>
      </span>
      {!busy && (
        <button className="button secondary" onClick={onRecheck}>
          Run check
        </button>
      )}
    </div>
  );
}
function Nav({
  back,
  busy,
  next,
}: {
  back: () => void;
  busy: boolean;
  next: () => void;
}) {
  return (
    <div className="form-actions">
      <button className="button secondary" onClick={back}>
        Back
      </button>
      <Action busy={busy} onClick={next}>
        Save and continue
      </Action>
    </div>
  );
}
function FileField({
  label,
  file,
  onChange,
  capture,
}: {
  label: string;
  file: File | undefined;
  onChange: (file: File | undefined) => void;
  capture?: boolean;
}) {
  const captureRef = useRef<HTMLInputElement>(null);
  return (
    <div className="file-field">
      <label className="file-input">
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => onChange(e.target.files?.[0])}
        />
        <span>
          <b>{file?.name ?? label}</b>
          <small>
            {file ? `${Math.ceil(file.size / 1024)} KB` : "PDF, JPG or PNG"}
          </small>
        </span>
        <em>{file ? "Replace" : "Choose file"}</em>
      </label>
      {capture && (
        <>
          <input
            ref={captureRef}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => onChange(e.target.files?.[0])}
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => captureRef.current?.click()}
          >
            Take photo
          </button>
        </>
      )}
    </div>
  );
}
