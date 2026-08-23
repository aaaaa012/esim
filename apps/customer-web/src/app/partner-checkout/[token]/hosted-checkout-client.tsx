"use client";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  LoaderCircle,
  LockKeyhole,
  QrCode,
  ShieldCheck,
  Signal,
  UserRound,
} from "lucide-react";
import { flagEmoji } from "../../country-picker";
import { apiErrorMessage, DocumentType } from "@visa-compass/shared";
import DatePicker from "../../esim/checkout/date-picker";
import ErrorModal from "../../../components/error-modal";
import "../../esim/checkout/checkout.css";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Envelope<T> = { data: T; error?: { code?: string; message: string } };

type Brand = { logoUrl?: string; colors?: { primary?: string } } | null;
type Session = {
  sessionId: string;
  expiresAt: string;
  partner: { name?: string; slug?: string | null; brand?: Brand } | null;
  order: {
    id: string;
    orderNumber: string;
    orderType?: string;
    status: string;
    amountNpr: number;
    currency: string;
    plan: {
      id: string;
      name: string;
      country: string;
      countryCode: string;
      dataAllowance: string;
      validityDays: number;
    };
    travelerComplete: boolean;
    documents: {
      id: string;
      type: string;
      status: string;
      fileName: string;
      passportVerificationStatus?: string | null;
    }[];
    requiredDocuments: string[];
  };
};
type Verification = {
  status: string;
  matchedFields?: string[];
  confidence?: number;
  checkedAt?: string;
  method?: string;
  detail?: string;
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
};

const api = async <T,>(path: string, init?: RequestInit) => {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (e) {
    throw new Error(
      e instanceof Error && e.message
        ? `Network error: ${e.message}`
        : "Network error — please check your connection and try again",
    );
  }
  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new Error(
      `The server returned an invalid response (${response.status}). Please try again.`,
    );
  }
  if (!payload.data && !payload.error) {
    if (response.ok) return undefined as T;
    throw new Error(`Request failed (${response.status})`);
  }
  if (!response.ok || !payload.data)
    throw new Error(
      apiErrorMessage(
        payload.error?.code ?? "UNEXPECTED",
        payload.error?.message ?? "Something went wrong",
      ),
    );
  return payload.data;
};

export default function HostedCheckoutClient({ token }: { token: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState(1);
  const [traveler, setTraveler] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof Traveler, string>>
  >({});
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [verification, setVerification] = useState<Verification | null>(null);
  const [consent, setConsent] = useState(false);
  const [compatible, setCompatible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyingDoc, setVerifyingDoc] = useState<
    "in-progress" | "waiting" | "done" | "failed" | null
  >(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ orderNumber: string } | null>(null);

  useEffect(() => {
    if (!verifyingDoc || verifyingDoc === "in-progress") return;
    const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (verifyingDoc === "failed") setStep(3);
      setVerifyingDoc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [verifyingDoc]);

  useEffect(() => {
    let cancelled = false;
    api<Session>(`/partner-checkout/${token}`)
      .then((value) => {
        if (cancelled) return;
        setSession(value);
        if (value.order.orderType === "TOPUP") {
          setStep(4);
          return;
        }
        const uploaded = value.order.requiredDocuments.filter((type) =>
          value.order.documents.some((doc) => doc.type === type),
        );
        const allUploaded =
          value.order.requiredDocuments.length > 0 &&
          uploaded.length === value.order.requiredDocuments.length;
        const passport = value.order.documents.find(
          (doc) => doc.type === "PASSPORT",
        );
        if (passport?.passportVerificationStatus) {
          setVerification({
            status: passport.passportVerificationStatus,
            method: "tesseract-ocr",
          });
        }
        if (allUploaded) setStep(4);
        else if (uploaded.length > 0 || value.order.travelerComplete)
          setStep(uploaded.length > 0 ? 3 : 2);
        else setStep(1);
      })
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
  }, [token]);

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
  const update = (key: keyof Traveler, value: string) => {
    setTraveler((v) => ({ ...v, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
  };

  const stepFromUrl = () => {
    const value = Number(new URLSearchParams(window.location.search).get("step"));
    return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1;
  };
  const stepPush = (next: number) => {
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("step", String(next));
        window.history.pushState({ step: next }, "", url.toString());
      } catch {
        /* history unavailable */
      }
    }
    setStep(next);
  };
  const stepBack = () => {
    if (typeof window !== "undefined" && window.history.state?.step) {
      window.history.back();
    } else {
      setStep((v) => Math.max(1, v - 1));
    }
  };
  // Jump back to an already-completed step: replace the current entry so the
  // back-stack stays intact (no forward clutter from navigating backwards).
  const stepJump = (next: number) => {
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("step", String(next));
        window.history.replaceState({ step: next }, "", url.toString());
      } catch {
        /* history unavailable */
      }
    }
    setStep(next);
  };
  useEffect(() => {
    const onPop = () => setStep(Math.min(4, Math.max(1, stepFromUrl())));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const nextStep = () => stepPush(Math.min(step + 1, 4));
  const prevStep = () => stepBack();

  const saveTraveler = () =>
    run(async () => {
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
      const nextErrors: Partial<Record<keyof Traveler, string>> = {};
      for (const [key, label] of required)
        if (!traveler[key].trim()) nextErrors[key] = `${label} is required`;
      if (traveler.email && !/^\S+@\S+\.\S+$/.test(traveler.email))
        nextErrors.email = "Enter a valid email address";
      if (traveler.mobile && !/^\+?[0-9][0-9\s-]{6,19}$/.test(traveler.mobile))
        nextErrors.mobile = "Enter a valid mobile number";
      if (traveler.passportNumber && traveler.passportNumber.length < 5)
        nextErrors.passportNumber =
          "Passport number must be at least 5 characters";
      if (traveler.dateOfBirth && new Date(traveler.dateOfBirth) >= new Date())
        nextErrors.dateOfBirth = "Date of birth must be in the past";
      if (
        traveler.passportExpiryDate &&
        new Date(traveler.passportExpiryDate) <= new Date()
      )
        nextErrors.passportExpiryDate = "Passport must not be expired";
      setFieldErrors(nextErrors);
      if (Object.keys(nextErrors)[0])
        throw new Error("Check the highlighted traveller details");
      if (
        traveler.nationality.length !== 2 ||
        traveler.countryOfResidence.length !== 2
      )
        throw new Error(
          "Nationality and country of residence must use two-letter codes",
        );
      const body = Object.fromEntries(
        Object.entries(traveler).filter(([, v]) => v !== ""),
      );
      await api(`/partner-checkout/${token}/traveler`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      nextStep();
    });

  const runVerification = async (): Promise<boolean> => {
    const result = await api<Verification>(
      `/partner-checkout/${token}/verify-passport`,
      { method: "POST", body: "{}" },
    );
    setVerification(result);
    const ok = result.status === "VERIFIED" || result.status === "SKIPPED";
    const waiting = ["OCR_PENDING", "OCR_BACKGROUND", "MANUAL_REVIEW"].includes(
      result.status,
    );
    setVerifyingDoc(ok ? "done" : waiting ? "waiting" : "failed");
    setSession((s) =>
      s
        ? {
            ...s,
            order: {
              ...s.order,
              documents: s.order.documents.map((d) =>
                d.type === "PASSPORT"
                  ? { ...d, passportVerificationStatus: result.status }
                  : d,
              ),
            },
          }
        : s,
    );
    return ok;
  };

  const verifyPassport = () =>
    run(async () => {
      setVerifying(true);
      setVerifyingDoc("in-progress");
      try {
        if (await runVerification()) setStep(4);
      } catch {
        setVerifyingDoc("failed");
      } finally {
        setVerifying(false);
      }
    });

  const saveDocuments = () =>
    run(async () => {
      setVerifyingDoc("in-progress");
      try {
        const required = session?.order.requiredDocuments ?? [
          "PASSPORT",
          "TICKET",
        ];
        for (const type of required) {
          const file = files[type];
          if (!file)
            throw new Error(
              `Upload your ${type === "PASSPORT" ? "passport" : type.toLowerCase()} to continue`,
            );
          if (file.size > 10 * 1024 * 1024)
            throw new Error(`${file.name} exceeds the 10 MB limit`);
          const authorization = await api<{
            id: string;
            type: string;
            status: string;
            upload: Record<string, unknown>;
          }>(`/partner-checkout/${token}/documents`, {
            method: "POST",
            body: JSON.stringify({ type, fileName: file.name }),
          });
          const upload = authorization.upload as {
            mode: string;
            endpoint?: string;
            apiKey?: string;
            publicId?: string;
            deliveryType?: string;
            timestamp?: number;
            signature?: string;
            folder?: string;
            allowedFormats?: string;
          };
          if (upload.mode === "local-simulator") {
            await api(
              `/partner-checkout/${token}/documents/${authorization.id}/confirm`,
              { method: "POST", body: "{}" },
            );
            continue;
          }
          if (
            upload.mode !== "cloudinary-signed" ||
            !upload.endpoint ||
            !upload.timestamp ||
            !upload.signature
          )
            throw new Error("Private document storage is unavailable");
          const form = new FormData();
          form.append("file", file);
          form.append("api_key", upload.apiKey!);
          form.append("timestamp", String(upload.timestamp));
          form.append("signature", upload.signature);
          form.append("folder", upload.folder!);
          form.append("public_id", upload.publicId!);
          form.append("type", upload.deliveryType!);
          if (upload.allowedFormats)
            form.append("allowed_formats", upload.allowedFormats);
          const uploaded = await fetch(upload.endpoint, {
            method: "POST",
            body: form,
          });
          if (!uploaded.ok) {
            let bodyText = "";
            try {
              bodyText = ((await uploaded.text()) ?? "").slice(0, 200);
            } catch {
              /* ignore */
            }
            throw new Error(
              bodyText
                ? `Upload failed for ${file.name}: ${bodyText}`
                : `Upload failed for ${file.name}`,
            );
          }
          await api(
            `/partner-checkout/${token}/documents/${authorization.id}/confirm`,
            { method: "POST", body: "{}" },
          );
        }
        if (await runVerification()) setStep(4);
      } catch (e) {
        setVerifyingDoc(null);
        throw e;
      }
    });

  const gatePassed =
    !session ||
    session.order.orderType === "TOPUP" ||
    verification?.status === "VERIFIED" ||
    verification?.status === "SKIPPED";

  const complete = () =>
    run(async () => {
      if (!consent)
        throw new Error("Please confirm that you accept before completing");
      const result = await api<{
        orderId: string;
        orderNumber: string;
        status: string;
      }>(`/partner-checkout/${token}/complete`, {
        method: "POST",
        body: JSON.stringify({
          consentAccepted: true,
          compatibilityAccepted: true,
        }),
      });
      setDone({ orderNumber: result.orderNumber });
    });

  if (loadFailed || (session && session.order.status !== "DRAFT" && !done))
    return (
      <main className="checkout-page">
        <div className="checkout-recovery">
          <QrCode />
          <h1>Checkout unavailable</h1>
          <p>
            The checkout link is invalid, expired, or has already been
            completed.
          </p>
        </div>
      </main>
    );
  if (!session && !loadFailed)
    return (
      <main className="checkout-page">
        <div className="checkout-shell">
          <div className="form-error">Loading your checkout…</div>
        </div>
      </main>
    );

  const plan = session!.order.plan;
  const isTopUp = session!.order.orderType === "TOPUP";
  return (
    <main className="checkout-page">
      <ErrorModal error={error || null} onClose={() => setError("")} />
      <div className="checkout-shell">
        <div className="checkout-heading">
          {session?.partner?.name && (
            <div className="hosted-brand">
              {session.partner.brand?.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.partner.brand.logoUrl}
                  alt={session.partner.name}
                  className="partner-logo"
                />
              )}
              <span className="eyebrow">
                <LockKeyhole size={13} />
                Checkout via {session.partner.name}
              </span>
            </div>
          )}
          <h1>Your travel eSIM</h1>
          <p>
            Complete your traveller details and documents to activate your{" "}
            {plan.name} eSIM securely.
          </p>
        </div>
        <div className="checkout-progress">
          <span style={{ width: `${step * (100 / 4)}%` }} />
        </div>
        <div className="checkout-layout">
          <section className="checkout-card">
            {done ? (
              <div className="form-section">
                <div className="success-panel">
                  <CheckCircle2 size={42} />
                  <b>Order completed</b>
                  <span>{done.orderNumber}</span>
                  <p>
                    Your eSIM is being activated automatically. The partner will
                    send your activation QR to you shortly.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="step-tabs">
                  {(isTopUp
                    ? ["Compatibility", "Review"]
                    : ["Compatibility", "Traveller", "Documents", "Review"]
                  ).map((label, index) => {
                    const value = isTopUp ? (index === 0 ? 1 : 4) : index + 1;
                    return (
                      <div
                        key={label}
                        className={
                          step === value ? "active" : step > value ? "done" : ""
                        }
                      >
                        <i>{step > value ? <Check size={13} /> : value}</i>
                        {step > value ? (
                          <button type="button" onClick={() => stepJump(value)} title={`Go back to ${label}`}>
                            <span>{label}</span>
                          </button>
                        ) : (
                          <span>{label}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {step === 1 && (
                  <div className="form-section">
                    <span className="form-icon">
                      <ShieldCheck />
                    </span>
                    <h1>Device compatibility</h1>
                    <p>
                      Your phone must support eSIM and be carrier-unlocked.
                      Coverage starts after first connection at your
                      destination.
                    </p>
                    <label className="confirm-box">
                      <input
                        type="checkbox"
                        checked={compatible}
                        onChange={(e) => setCompatible(e.target.checked)}
                      />
                      <span>
                        <b>I confirm my device is eSIM compatible</b>
                        <small>
                          Incompatible devices are not eligible for a refund.
                        </small>
                      </span>
                    </label>
                    <Nav
                      back={() => {}}
                      backHidden
                      busy={busy}
                      next={() =>
                        run(async () => {
                          if (!compatible)
                            throw new Error(
                              "Confirm your device is eSIM compatible first",
                            );
                          setStep(isTopUp ? 4 : 2);
                        })
                      }
                    />
                  </div>
                )}
                {step === 2 && (
                  <div className="form-section">
                    <span className="form-icon">
                      <UserRound />
                    </span>
                    <h1>Traveller information</h1>
                    <p>
                      Enter details exactly as shown on the passport. Use
                      two-letter country codes.
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
                          name="firstName"
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
                          name="surname"
                          value={traveler.surname}
                          onChange={(e) => update("surname", e.target.value)}
                        />
                      </Field>
                      <Field
                        label="Date of birth"
                        error={fieldErrors.dateOfBirth}
                      >
                        <DatePicker
                          name="dateOfBirth"
                          value={traveler.dateOfBirth}
                          max={new Date(Date.now() - 86_400_000)
                            .toISOString()
                            .slice(0, 10)}
                          placeholder="Choose date of birth"
                          onChange={(value) => update("dateOfBirth", value)}
                        />
                      </Field>
                      <Field
                        label="Passport number"
                        error={fieldErrors.passportNumber}
                      >
                        <input
                          name="passportNumber"
                          value={traveler.passportNumber}
                          onChange={(e) =>
                            update(
                              "passportNumber",
                              e.target.value.toUpperCase(),
                            )
                          }
                        />
                      </Field>
                      <Field
                        label="Passport expiry"
                        error={fieldErrors.passportExpiryDate}
                      >
                        <DatePicker
                          name="passportExpiryDate"
                          value={traveler.passportExpiryDate}
                          min={new Date(Date.now() + 86_400_000)
                            .toISOString()
                            .slice(0, 10)}
                          placeholder="Choose passport expiry"
                          onChange={(value) =>
                            update("passportExpiryDate", value)
                          }
                        />
                      </Field>
                      <Field
                        label="Nationality"
                        error={fieldErrors.nationality}
                      >
                        <input
                          name="nationality"
                          placeholder="NP"
                          list="hc-country-codes"
                          maxLength={2}
                          value={traveler.nationality}
                          onChange={(e) =>
                            update("nationality", e.target.value.toUpperCase())
                          }
                        />
                      </Field>
                      <Field label="City / district" error={fieldErrors.city}>
                        <input
                          name="city"
                          value={traveler.city}
                          onChange={(e) => update("city", e.target.value)}
                        />
                      </Field>
                      <Field
                        label="Country of residence"
                        error={fieldErrors.countryOfResidence}
                      >
                        <input
                          name="countryOfResidence"
                          placeholder="NP"
                          list="hc-country-codes"
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
                          name="email"
                          type="email"
                          value={traveler.email}
                          onChange={(e) => update("email", e.target.value)}
                        />
                      </Field>
                      <Field
                        label="Mobile / WhatsApp"
                        error={fieldErrors.mobile}
                      >
                        <input
                          name="mobile"
                          inputMode="tel"
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
                    <datalist id="hc-country-codes">
                      <option value="NP">Nepal</option>
                      <option value="IN">India</option>
                      <option value="US">United States</option>
                      <option value="GB">United Kingdom</option>
                      <option value="AE">United Arab Emirates</option>
                      <option value="JP">Japan</option>
                    </datalist>
                    <Nav
                      back={() => prevStep()}
                      busy={busy}
                      next={saveTraveler}
                    />
                  </div>
                )}
                {step === 3 && (
                  <div className="form-section">
                    <span className="form-icon">
                      <FileCheck2 />
                    </span>
                    <h2>Travel documents</h2>
                    <p>
                      PDF, JPG or PNG. Your documents are kept private and
                      verified securely.
                    </p>
                    <div className="upload-list">
                      {session!.order.requiredDocuments.map((type) => (
                        <FileField
                          key={type}
                          label={
                            type === "PASSPORT"
                              ? "Passport"
                              : type === "TICKET"
                                ? "Travel ticket"
                                : "Visa"
                          }
                          file={files[type]}
                          onChange={(v) =>
                            setFiles((f) => ({ ...f, [type]: v }))
                          }
                        />
                      ))}
                    </div>
                    <Nav
                      back={() => prevStep()}
                      busy={busy}
                      next={saveDocuments}
                    />
                  </div>
                )}
                {step === 4 && (
                  <div className="form-section">
                    {isTopUp ? (
                      <h2>Review &amp; confirm data top-up</h2>
                    ) : (
                      <h2>Review &amp; confirm</h2>
                    )}
                    {!isTopUp &&
                      (verification === null && !verifying ? (
                        <PassportCheck
                          status={undefined}
                          busy={false}
                          onRecheck={() => void verifyPassport()}
                        />
                      ) : verification === null ? (
                        <PassportCheck
                          status={undefined}
                          busy={verifying}
                          onRecheck={() => void verifyPassport()}
                        />
                      ) : (
                        <PassportCheck
                          status={verification.status}
                          busy={false}
                          onRecheck={() => void verifyPassport()}
                          onEdit={() => setStep(2)}
                        />
                      ))}
                    {isTopUp && (
                      <p className="form-note">
                        This is a data top-up for your existing eSIM. No
                        traveller details or new documents are required.
                      </p>
                    )}
                    <label className="confirm-box">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      <span>
                        <b>
                          {isTopUp
                            ? "I confirm I want to top up my existing eSIM"
                            : "I confirm the traveller details and documents are correct"}
                        </b>
                        <small>
                          Your order will be submitted to{" "}
                          {session?.partner?.name ?? "the partner"} for
                          activation.
                        </small>
                      </span>
                    </label>
                    <div className="form-actions">
                      {!isTopUp && (
                        <button
                          className="button secondary"
                          onClick={() => stepJump(3)}
                        >
                          <ChevronLeft size={16} /> Documents
                        </button>
                      )}
                      {isTopUp && (
                        <button
                          className="button secondary"
                          onClick={() => stepJump(1)}
                        >
                          <ChevronLeft size={16} /> Back
                        </button>
                      )}
                      <Action
                        busy={busy}
                        disabled={verifying || !gatePassed || !consent}
                        onClick={complete}
                      >
                        Complete order
                      </Action>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
          <aside className="order-summary">
            <div className="summary-plan">
              <span className="summary-flag">
                {flagEmoji(plan.countryCode) ?? <Signal size={22} />}
              </span>
              <span className="summary-plan-info">
                <span className="summary-label">Order summary</span>
                <b>{plan.name}</b>
                <small>
                  {plan.countryCode} · {plan.dataAllowance}
                </small>
              </span>
            </div>
            <div>
              <small>Destination</small>
              <b>{plan.countryCode}</b>
            </div>
            <div>
              <small>Data &amp; validity</small>
              <b>
                {plan.dataAllowance} · {plan.validityDays} days
              </b>
            </div>
            <div className="summary-total">
              <small>Total</small>
              <b>
                {session!.order.currency}{" "}
                {session!.order.amountNpr.toLocaleString()}
              </b>
            </div>
            <p>
              <LockKeyhole size={14} /> Price is frozen by your agent.
            </p>
            <p>
              <ShieldCheck size={14} /> Your documents are encrypted and
              verified securely.
            </p>
          </aside>
        </div>
      </div>
      {verifyingDoc && (
        <div
          className="verify-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="verify-modal-title"
          onClick={(event) => {
            if (verifyingDoc === "in-progress") return;
            if (event.target !== event.currentTarget) return;
            if (verifyingDoc === "failed") setStep(2);
            setVerifyingDoc(null);
          }}
        >
          <div
            className={`verify-modal ${verifyingDoc === "in-progress" || verifyingDoc === "waiting" ? "checking" : verifyingDoc === "done" ? "done" : "failed"}`}
          >
            {verifyingDoc === "in-progress" ? (
              <>
                <LoaderCircle className="spin verify-modal-icon" size={38} />
                <b id="verify-modal-title">Verifying your passport</b>
                <p>
                  We are uploading your documents securely and checking your
                  passport against the traveller details you entered. This
                  usually takes a few seconds…
                </p>
              </>
            ) : verifyingDoc === "waiting" ? (
              <>
                <LoaderCircle className="spin verify-modal-icon" size={38} />
                <b id="verify-modal-title">Your verification is still in progress</b>
                <p>
                  This can take a few minutes. Keep this page open and try
                  again shortly. If it still has not completed, contact
                  {" "}{session?.partner?.name ?? "your travel partner"} with
                  your order number.
                </p>
              </>
            ) : verifyingDoc === "done" ? (
              <>
                <CheckCircle2 className="verify-modal-icon" size={38} />
                <b id="verify-modal-title">
                  {verification?.status === "SKIPPED"
                    ? "Verification skipped"
                    : "Passport verified"}
                </b>
                <p>
                  {verification?.status === "SKIPPED"
                    ? "Document verification is disabled in this environment."
                    : verification?.status === "VERIFIED"
                      ? "Your passport matches the details you provided. You can now review and confirm your order."
                      : "Your passport matched your traveller details."}
                </p>
              </>
            ) : (
              <>
                <AlertTriangle className="verify-modal-icon" size={38} />
                <b id="verify-modal-title">We could not verify your passport</b>
                <p>
                  Your passport doesn&apos;t match the traveller details you
                  entered. Review your details first, or try a clearer photo of
                  your passport.
                </p>
              </>
            )}
            {verifyingDoc !== "in-progress" && (
              <div className="form-actions">
                {verifyingDoc === "waiting" ? (
                  <>
                    <button
                      className="button secondary"
                      autoFocus
                      onClick={() => setVerifyingDoc(null)}
                    >
                      Keep waiting
                    </button>
                    <button
                      className="button primary"
                      onClick={() => void verifyPassport()}
                    >
                      Check again
                    </button>
                  </>
                ) : verifyingDoc === "failed" ? (
                  <>
                    <button
                      className="button secondary"
                      autoFocus
                      onClick={() => {
                        setStep(2);
                        setVerifyingDoc(null);
                      }}
                    >
                      Edit traveller details
                    </button>
                    <button
                      className="button primary"
                      onClick={() => {
                        setStep(3);
                        setVerifyingDoc(null);
                      }}
                    >
                      Back to documents
                    </button>
                  </>
                ) : (
                  <button
                    className="button primary"
                    autoFocus
                    onClick={() => setVerifyingDoc(null)}
                  >
                    Continue
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
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
      {error && <small className="field-error">{error}</small>}
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
    <button
      className="button wide"
      disabled={busy || disabled}
      onClick={onClick}
    >
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
  backHidden,
}: {
  back: () => void;
  busy: boolean;
  next: () => void;
  backHidden?: boolean;
}) {
  return (
    <div className="form-actions">
      {!backHidden && (
        <button className="button secondary" onClick={back}>
          Back
        </button>
      )}
      <Action busy={busy} onClick={next}>
        Save and continue
      </Action>
    </div>
  );
}
function PassportCheck({
  status,
  busy,
  onRecheck,
  onEdit,
}: {
  status: string | undefined;
  busy: boolean;
  onRecheck: () => void;
  onEdit?: () => void;
}) {
  if (status === "VERIFIED")
    return (
      <div className="passport-check verified">
        <CheckCircle2 size={20} />
        <span>
          <b>Passport verified</b>
          <small>Your passport matches your traveller details.</small>
        </span>
      </div>
    );
  if (status === "SKIPPED")
    return (
      <div className="passport-check skipped">
        <ShieldCheck size={20} />
        <span>
          <b>Passport check</b>
          <small>Document verification is disabled in this environment.</small>
        </span>
      </div>
    );
  if (busy)
    return (
      <div className="passport-check checking">
        <LoaderCircle className="spin" size={20} />
        <span>
          <b>Verifying your passport</b>
          <small>
            Reading the document and comparing it with your traveller details…
          </small>
        </span>
      </div>
    );
  if (status === "PARTIAL")
    return (
      <div className="passport-check warning">
        <AlertTriangle size={20} />
        <span>
          <b>Partial match</b>
          <small>
            Your passport number matched, but not all details. Check your
            traveller details or re-check with a clearer photo.
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
  if (status === "FAILED")
    return (
      <div className="passport-check failed">
        <AlertTriangle size={20} />
        <span>
          <b>Passport doesn&apos;t match</b>
          <small>
            We couldn&apos;t verify your details from the uploaded passport.
            Review your traveller details, then re-check.
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
  return (
    <div className="passport-check">
      <ShieldCheck size={20} />
      <span>
        <b>Passport check</b>
        <small>
          We read your passport and compare it with your traveller details
          before completion.
        </small>
      </span>
      <button className="button secondary" onClick={onRecheck}>
        Run check
      </button>
    </div>
  );
}
function FileField({
  label,
  file,
  onChange,
}: {
  label: string;
  file: File | undefined;
  onChange: (file: File | undefined) => void;
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
    </div>
  );
}
