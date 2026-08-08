"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useAuth } from "@clerk/nextjs";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, FileCheck2, LoaderCircle, LockKeyhole, ShieldCheck, Signal } from "lucide-react";
import { flagEmoji } from "../../country-picker";
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
}: {
  planId: string;
  orderId: string;
  mobile?: string;
}) {
  const authFetch = useAuthenticatedFetch();
  const { isLoaded, isSignedIn } = useAuth();
  const readToken = () => {
    let t = "";
    try {
      t = sessionStorage.getItem("vc_guest_token") ?? "";
    } catch {
      t = "";
    }
    if (t) return t;
    try {
      return localStorage.getItem("vc_guest_token") ?? "";
    } catch {
      return "";
    }
  };
  const [guestToken, setGuestToken] = useState(readToken);
  const guestTokenRef = useRef(guestToken);
  guestTokenRef.current = guestToken;
  const currentToken = () => guestTokenRef.current || readToken();
  const storeGuestToken = (t: string) => {
    guestTokenRef.current = t;
    setGuestToken(t);
    try {
      sessionStorage.setItem("vc_guest_token", t);
    } catch {
      /* sessionStorage unavailable */
    }
    try {
      localStorage.setItem("vc_guest_token", t);
    } catch {
      /* localStorage unavailable */
    }
  };
  const [guest, setGuest] = useState<boolean>(() =>
    readToken() ? true : isSignedIn === true ? false : true,
  );
  const guestRef = useRef(guest);
  guestRef.current = guest;
  useEffect(() => {
    if (isLoaded && !guestRef.current) setGuest(isSignedIn === true ? false : true);
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
    if (!response.ok) throw new Error(apiErrorMessage(payload.error?.code ?? "", payload.error?.message ?? "Something went wrong"));
    return payload.data;
  };

  const [step, setStep] = useState(1),
    [compatible, setCompatible] = useState(false),
    [traveler, setTraveler] = useState(initial);
  const isTopUpIntent = Boolean(mobile) && !orderId;
  const [previewPlan, setPreviewPlan] = useState<PlanSummary | null>(null);
  useEffect(() => {
    if (!planId || orderId) return;
    let cancelled = false;
    fetch(`${API}/public/plans`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("catalog unavailable"))))
      .then((data: Envelope<PlanSummary[]>) => {
        if (cancelled) return;
        const plan = data.data.find((item) => item.id === planId);
        if (plan) setPreviewPlan(plan);
      })
      .catch(() => {});
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
  const summaryPlan = order?.plan ?? previewPlan;
  const isTopUp = order?.purchaseType === "TOPUP" || isTopUpIntent;
  const [provider, setProvider] = useState<PaymentProvider>(
      PaymentProvider.KHALTI,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [verifying, setVerifying] = useState(false);
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
        if (!["DRAFT", "PAYMENT_PENDING"].includes(value.status))
          throw new Error("This order can no longer be resumed from checkout");
        setOrder(value);
        setCompatible(true);
        if (value.traveler) setTraveler({ ...initial, ...value.traveler });
        if (value.purchaseType === "TOPUP") {
          setStep(4);
          if (value.status === "PAYMENT_PENDING" && value.payment) {
            setPayment({ reference: value.payment.reference, redirectUrl: "", expiresAt: "" });
            if (hasReturnReference()) void verifyPayment(value);
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
          if (hasReturnReference()) void verifyPayment(value);
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
  const hasReturnReference = () => {
    const params = new URLSearchParams(window.location.search);
    return params.has("reference") || params.has("pidx");
  };
  const verifyPayment = async (initialOrder: Order) => {
    setVerifying(true);
    try {
      await api(`/customer/orders/${initialOrder.id}/payment/verify`, {
        method: "POST",
        body: JSON.stringify({ reference: initialOrder.payment?.reference }),
      });
    } catch {
      // Verification may fail until the provider webhook lands; polling below retries.
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const updated = await api<Order>(
        `/customer/orders/${initialOrder.id}`,
      ).catch(() => initialOrder);
      setOrder(updated);
      setError("");
      if (
        ["PAYMENT_CONFIRMED", "REVIEW_PENDING", "APPROVED", "PROVISIONING", "COMPLETED", "PAYMENT_FAILED", "PROVISIONING_FAILED", "CANCELLED"].includes(
          updated.status,
        )
      ) {
        setVerifying(false);
        break;
      }
      if (attempt === 29) {
        setError(
          "Your payment is still being confirmed. Check your eSIMs shortly.",
        );
        setVerifying(false);
      }
    }
  };
  const update = (key: keyof Traveler, value: string) =>
    setTraveler((v) => ({ ...v, [key]: value }));
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
      if (!planId) throw new Error("Choose a plan before checkout");
      if (!compatible && !isTopUpIntent) throw new Error("Confirm device compatibility");
      if (guest) {
        const created = await api<{ order: Order; token: string }>("/customer/orders", {
          method: "POST",
          body: JSON.stringify({
            planId,
            compatibilityAccepted: true,
            mobile: (mobile || traveler.mobile) || undefined,
          }),
        });
        setOrder(created.order);
        storeGuestToken(created.token);
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
        body: JSON.stringify({ planId, compatibilityAccepted: true }),
      });
      const isGuestPayload =
        typeof payload === "object" && payload !== null && "order" in payload && "token" in payload;
      const finalOrder: Order = isGuestPayload
        ? (payload as { order: Order }).order
        : (payload as Order);
      setOrder(finalOrder);
      if (isGuestPayload) {
        storeGuestToken((payload as { token: string }).token);
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
        ["email", "Email"],
        ["mobile", "Mobile / WhatsApp"],
      ];
      const missing = required.find(([key]) => !traveler[key].trim());
      if (missing) throw new Error(`${missing[1]} is required`);
      if (!/^\S+@\S+\.\S+$/.test(traveler.email))
        throw new Error("Enter a valid email address");
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
      setStep(4);
    });
  const initiate = (orderArg?: Order) =>
    run(async () => {
      const target = orderArg ?? order;
      if (target) {
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
      const endpoint = SIMULATOR
        ? guest
          ? `/customer/orders/${order.id}/payment/simulate`
          : `/customer/orders/${order.id}/payment/simulate-complete`
        : `/customer/orders/${order.id}/payment/verify`;
      setOrder(
        await api<Order>(
          endpoint,
          {
            method: "POST",
            body: JSON.stringify({ reference: payment.reference }),
          },
        ),
      );
    });

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
              ? "Recharge your existing eSIM. No verification needed — pay and activate in seconds."
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
                  <Field label="First name">
                    <input
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
                  <Field label="Surname">
                    <input
                      value={traveler.surname}
                      onChange={(e) => update("surname", e.target.value)}
                    />
                  </Field>
                  <Field label="Date of birth">
                    <input
                      type="date"
                      value={traveler.dateOfBirth}
                      onChange={(e) => update("dateOfBirth", e.target.value)}
                    />
                  </Field>
                  <Field label="Passport number">
                    <input
                      value={traveler.passportNumber}
                      onChange={(e) =>
                        update("passportNumber", e.target.value.toUpperCase())
                      }
                    />
                  </Field>
                  <Field label="Passport expiry">
                    <input
                      type="date"
                      value={traveler.passportExpiryDate}
                      onChange={(e) =>
                        update("passportExpiryDate", e.target.value)
                      }
                    />
                  </Field>
                  <Field label="Nationality">
                    <input
                      maxLength={2}
                      value={traveler.nationality}
                      onChange={(e) =>
                        update("nationality", e.target.value.toUpperCase())
                      }
                    />
                  </Field>
                  <Field label="City / district">
                    <input
                      value={traveler.city}
                      onChange={(e) => update("city", e.target.value)}
                    />
                  </Field>
                  <Field label="Country of residence">
                    <input
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
                  <Field label="Email">
                    <input
                      type="email"
                      value={traveler.email}
                      onChange={(e) => update("email", e.target.value)}
                    />
                  </Field>
                  <Field label="Mobile / WhatsApp">
                    <input
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
                  ["PAYMENT_CONFIRMED", "REVIEW_PENDING", "APPROVED", "PROVISIONING", "COMPLETED"].includes(
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
                {order?.status === "COMPLETED" ? (
                  <div className="success-panel">
                    <CheckCircle2 size={42} />
                    <b>Your eSIM is ready</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      Your activation QR was emailed to you as a password-protected
                      PDF. Open it on your phone and enter the eSIM number
                      (MSISDN) shown in your email to reveal the QR.
                    </p>
                    <Link className="button" href="/account/esims">
                      View my eSIMs
                    </Link>
                  </div>
                ) : order &&
                  ["PAYMENT_CONFIRMED", "REVIEW_PENDING", "APPROVED", "PROVISIONING"].includes(
                    order.status,
                  ) ? (
                  <div className="success-panel">
                    <LoaderCircle className="spin" size={42} />
                    <b>Payment verified — activating your eSIM</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      Your eSIM is being activated automatically. Your QR will be
                      emailed to you as a password-protected PDF shortly.
                    </p>
                    <Link className="button" href="/account/esims">
                      View my eSIMs
                    </Link>
                  </div>
                ) : verifying ? (
                  <div className="success-panel">
                    <LoaderCircle className="spin" size={42} />
                    <b>Confirming your payment</b>
                    <span>{order?.orderNumber}</span>
                    <p>
                      Your wallet confirmed the payment. We are verifying it
                      securely — this takes a few seconds.
                    </p>
                  </div>
                ) : (
                  <>
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
                            Reference: {payment.reference.slice(0, 14)}…
                          </small>
                          <Action busy={busy} onClick={complete}>
                            Simulate verified payment
                          </Action>
                        </div>
                      ) : (
                        <Action busy={busy} onClick={complete}>
                          Confirm my payment
                        </Action>
                      )
                    ) : isTopUp && !order ? (
                      <Action busy={busy} onClick={begin}>
                        Continue to payment
                      </Action>
                    ) : (
                      <Action busy={busy} onClick={() => void initiate()}>
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
              <b>{summaryPlan?.countryCode ?? "—"}</b>
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
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={full ? "full" : ""}>
      {label}
      {children}
    </label>
  );
}
function Action({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className="button wide" disabled={busy} onClick={onClick}>
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
