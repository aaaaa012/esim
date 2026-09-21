"use client";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
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
  Copy,
  Link2,
} from "lucide-react";
import { flagEmoji } from "../../country-picker";
import { apiErrorMessage, PaymentProvider } from "@visa-compass/shared";
import {
  DocumentProgress,
  SavedDocuments,
  VerifiedDocumentsSummary,
  hasSavedDocument,
  hasUploadedDocument,
} from "../../esim/checkout/document-progress";
import { createDocumentUploader } from "../../esim/checkout/document-upload";
import { useDocumentRefresh } from "../../esim/checkout/use-document-refresh";
import { DocumentFileField as FileField } from "../../esim/checkout/document-file-field";
import { DocumentRecoveryFields } from "../../esim/checkout/document-recovery";
import {
  CompatibilityConfirmation,
  PurchaseConsent,
} from "../../esim/checkout/checkout-confirmation";
import { useCheckoutTransition } from "../../esim/checkout/use-checkout-transition";
import DatePicker from "../../esim/checkout/date-picker";
import ErrorModal from "../../../components/error-modal";
import { formatPlanDataText } from "../../../lib/format-data";
import { fonepaySocketSignal } from "../../esim/checkout/payment-intent";
import {
  postFonepayTelemetry,
  type FonepayTelemetryPayload,
} from "../../esim/checkout/fonepay-telemetry";
import { FonepayCheckout } from "../../esim/checkout/fonepay-checkout";
import "../../esim/checkout/checkout.css";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const SIMULATOR = process.env.NEXT_PUBLIC_PAYMENT_MODE === "simulator";
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
    topUpMsisdnMasked?: string;
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
    traveler?: Traveler | null;
    passportExtraction?: {
      status: string;
      fields?: Partial<
        Pick<
          Traveler,
          | "firstName"
          | "middleName"
          | "surname"
          | "dateOfBirth"
          | "passportNumber"
          | "passportExpiryDate"
        >
      >;
      fieldsRequiringInput?: string[];
      failureCode?: string;
    } | null;
    documentReviewStatus?: string;
    documents: {
      id: string;
      type: string;
      status: string;
      fileName: string;
      uploadVerified?: boolean;
      passportVerificationStatus?: string | null;
    }[];
    requiredDocuments: string[];
  };
};
type Verification = {
  status: string;
  matchedFields?: string[];
  mismatchedFields?: Array<
    | "firstName"
    | "middleName"
    | "surname"
    | "dateOfBirth"
    | "nationality"
    | "passportNumber"
    | "passportExpiryDate"
  >;
  confidence?: number;
  checkedAt?: string;
  method?: string;
  detail?: string;
  passportExtraction?: Session["order"]["passportExtraction"];
};

type Payment = {
  reference: string;
  redirectUrl: string;
  expiresAt: string;
  qrDataUrl?: string;
  qrPayload?: string;
  websocketUrl?: string;
  banks?: {
    bankName: string;
    bankCode: string;
    bankIcon?: string;
    packageName?: string;
    intentScheme: string;
  }[];
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
  } catch {
    throw new Error("Check your connection and try again.");
  }
  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new Error(
      "The checkout service returned an unexpected response. Please try again.",
    );
  }
  if (!payload.data && !payload.error) {
    if (response.ok) return undefined as T;
    throw new Error("This checkout request could not be completed.");
  }
  if (!response.ok || !payload.data) {
    // Preserve the machine-readable code so callers can distinguish a
    // settled-verdict error (PAYMENT_EXPIRED / PAYMENT_NOT_CONFIRMED) from a
    // transient transport or provider failure.
    const error = new Error(
      apiErrorMessage(
        payload.error?.code ?? "UNEXPECTED",
        "This checkout request could not be completed.",
      ),
    ) as Error & { code?: string; status?: number };
    if (payload.error?.code) error.code = payload.error.code;
    error.status = response.status;
    throw error;
  }
  return payload.data;
};

export default function HostedCheckoutClient({ token }: { token: string }) {
  const authFetch = useAuthenticatedFetch();
  const { isLoaded, isSignedIn } = useAuth();
  const [session, setSession] = useState<Session | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState(1);
  const [traveler, setTraveler] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof Traveler, string>>
  >({});
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [editingVerifiedDocuments, setEditingVerifiedDocuments] =
    useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const previousVerificationStatus = useRef<string | undefined>(undefined);
  const [successMessage, setSuccessMessage] = useState("");
  const [documentAttentionMessage, setDocumentAttentionMessage] = useState("");
  const [compatibilityConsent, setCompatibilityConsent] = useState(false);
  const [legalConsent, setLegalConsent] = useState(false);
  const [resumeAfterConsent, setResumeAfterConsent] = useState(2);
  const consentKey = `hosted-checkout-consent:v1:${token}`;
  const clearSavedConsent = () => {
    try {
      window.sessionStorage.removeItem(consentKey);
    } catch {
      /* Storage may be unavailable. */
    }
  };
  const [showAccountChoice, setShowAccountChoice] = useState(false);
  const [checkoutAccessMode, setCheckoutAccessMode] = useState<
    "account" | "guest" | null
  >(null);
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [copiedCheckoutLink, setCopiedCheckoutLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [documentMessage, setDocumentMessage] = useState("");
  const [documentError, setDocumentError] = useState("");
  const uploadDocument = useRef(createDocumentUploader());
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [orderNumber, setOrderNumber] = useState("");
  const [outcome, setOutcome] = useState<{
    status: string;
    orderNumber: string;
  } | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [provider, setProvider] = useState<PaymentProvider>(
    PaymentProvider.KHALTI,
  );
  const [fonepayBankHint, setFonepayBankHint] = useState("");
  const [fonepaySocketReady, setFonepaySocketReady] = useState(false);
  const [lockedProvider, setLockedProvider] = useState<PaymentProvider | null>(
    null,
  );
  const [availableProviders, setAvailableProviders] = useState<
    PaymentProvider[]
  >([PaymentProvider.KHALTI]);
  const paymentVerificationInFlight = useRef(false);
  const fonepayExpiryChecked = useRef<string | undefined>(undefined);
  const stoppedForVerify = useRef(false);
  const appliedExtraction = useRef("");
  const awaitingVerificationAdvance = useRef(false);

  useEffect(() => {
    void api<{ providers: PaymentProvider[] }>("/payments/providers")
      .then((value) => {
        if (!value.providers.length) return;
        setAvailableProviders(value.providers);
        if (!value.providers.includes(provider)) {
          setProvider(value.providers[0]!);
          setLockedProvider(null);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<Session>(`/partner-checkout/${token}`)
      .then((value) => {
        if (cancelled) return;
        setSession(value);
        if (value.order.traveler)
          setTraveler({ ...initial, ...value.order.traveler });
        if (value.order.status !== "DRAFT") {
          setOrderNumber(value.order.orderNumber);
          if (value.order.status === "PAYMENT_PENDING") {
            setSubmitted(true);
            stepJump(4);
            return;
          }
          setOutcome({
            status: value.order.status,
            orderNumber: value.order.orderNumber,
          });
          return;
        }
        if (value.order.orderType === "TOPUP") {
          stepJump(1);
          return;
        }
        const uploaded = value.order.requiredDocuments.filter((type) =>
          hasSavedDocument(value.order.documents, type),
        );
        const allUploaded =
          value.order.requiredDocuments.length > 0 &&
          uploaded.length === value.order.requiredDocuments.length;
        const passport = value.order.documents.find(
          (doc) => doc.type === "PASSPORT",
        );
        if (value.order.documentReviewStatus) {
          setVerification({
            status: value.order.documentReviewStatus,
          });
        } else if (passport?.passportVerificationStatus) {
          setVerification({
            status: passport.passportVerificationStatus,
            method: "tesseract-ocr",
          });
        }
        awaitingVerificationAdvance.current =
          value.order.travelerComplete &&
          ["OCR_PENDING", "OCR_BACKGROUND"].includes(
            value.order.documentReviewStatus ?? "",
          );
        const resumeStep =
          value.order.documentReviewStatus === "REUPLOAD_REQUIRED"
            ? 2
            : !allUploaded
              ? 2
              : value.order.travelerComplete
                ? ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
                    value.order.documentReviewStatus ?? "",
                  )
                  ? 4
                  : 3
                : 3;
        setResumeAfterConsent(resumeStep);
        let accepted = false;
        try {
          accepted = window.sessionStorage.getItem(consentKey) === "accepted";
        } catch {
          /* Start at consent if storage is unavailable. */
        }
        setCompatibilityConsent(accepted);
        setLegalConsent(accepted);
        stepJump(accepted ? resumeStep : 1);
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

  const advanceAfterAccountChoice = (mode: "account" | "guest") => {
    setCheckoutAccessMode(mode);
    setShowAccountChoice(false);
    stepPush(session?.order.orderType === "TOPUP" ? 4 : resumeAfterConsent);
  };
  const continueWithAccount = () =>
    run(async () => {
      if (!isLoaded || isSignedIn !== true)
        throw new Error("Sign in securely before linking this checkout");
      const response = await authFetch(
        `${API}/partner-checkout/${encodeURIComponent(token)}/claim`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: "{}",
        },
      );
      const payload = (await response.json()) as Envelope<Session>;
      if (!response.ok || !payload.data)
        throw new Error(
          apiErrorMessage(
            payload.error?.code ?? "UNEXPECTED",
            "This checkout could not be linked to your account",
          ),
        );
      setSession(payload.data);
      advanceAfterAccountChoice("account");
    });
  useEffect(() => {
    if (!pendingSignIn || isSignedIn !== true) return;
    setPendingSignIn(false);
    void continueWithAccount();
  }, [pendingSignIn, isSignedIn]);

  const copyHostedCheckoutLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedCheckoutLink(true);
      window.setTimeout(() => setCopiedCheckoutLink(false), 2_500);
    } catch {
      setError(
        "Copy was blocked. Bookmark this private partner checkout link before closing the tab.",
      );
    }
  };

  const stepFromUrl = () => {
    const value = Number(
      new URLSearchParams(window.location.search).get("step"),
    );
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
      if (traveler.nationality.trim().length !== 2)
        nextErrors.nationality = "Use a two-letter country code, such as NP";
      if (traveler.countryOfResidence.trim().length !== 2)
        nextErrors.countryOfResidence =
          "Use a two-letter country code, such as NP";
      setFieldErrors(nextErrors);
      const firstError = Object.keys(nextErrors)[0];
      if (firstError) {
        const field = document.querySelector<HTMLElement>(
          `[name="${firstError}"]`,
        );
        field?.scrollIntoView({ behavior: "smooth", block: "center" });
        field?.focus();
        throw new Error("Check the highlighted traveller details");
      }
      const body = Object.fromEntries(
        Object.entries(traveler)
          .map(([key, value]) => [key, value.trim()])
          .filter(([, value]) => value !== ""),
      );
      const refreshed = await api<Session>(
        `/partner-checkout/${token}/traveler`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      setSession(refreshed);
      setVerification({
        status: refreshed.order.documentReviewStatus ?? "NOT_STARTED",
      });
      awaitingVerificationAdvance.current = true;
      const verified = await runVerification();
      if (verified) {
        awaitingVerificationAdvance.current = false;
        stepPush(4);
      }
    });

  const runVerification = async (): Promise<boolean> => {
    setDocumentMessage("Checking your passport…");
    const result = await api<Verification>(
      `/partner-checkout/${token}/verify-passport`,
      { method: "POST", body: "{}" },
    );
    setVerification(result);
    if (result.status === "CORRECTION_REQUIRED") {
      const mismatched = new Set(result.mismatchedFields ?? []);
      setFieldErrors({
        ...(mismatched.has("firstName")
          ? { firstName: "We couldn't automatically match this detail with your uploaded passport. Please check it." }
          : {}),
        ...(mismatched.has("middleName")
          ? { middleName: "We couldn't automatically match this detail with your uploaded passport. Please check it." }
          : {}),
        ...(mismatched.has("surname")
          ? { surname: "We couldn't automatically match this detail with your uploaded passport. Please check it." }
          : {}),
        ...(mismatched.has("dateOfBirth")
          ? { dateOfBirth: "We couldn't automatically match this detail with your uploaded passport. Please check it." }
          : {}),
        ...(mismatched.has("passportNumber")
          ? { passportNumber: "We couldn't automatically match this detail with your uploaded passport. Please check it." }
          : {}),
        ...(mismatched.has("passportExpiryDate")
          ? { passportExpiryDate: "We couldn't automatically match this detail with your uploaded passport. Please check it." }
          : {}),
        ...(mismatched.has("nationality")
          ? { nationality: "We couldn't automatically match this detail with your uploaded passport. Please check it." }
          : {}),
      });
    }
    const ok = ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
      result.status,
    );
    setSession((s) =>
      s
        ? {
            ...s,
            order: {
              ...s.order,
              documentReviewStatus: result.status,
              ...(result.passportExtraction !== undefined
                ? { passportExtraction: result.passportExtraction }
                : {}),
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
      setDocumentError("");
      try {
        await runVerification();
      } catch {
        setDocumentError(
          "Could not connect to verification. Your saved files are safe. Try checking again.",
        );
      } finally {
        setVerifying(false);
      }
    });

  const saveDocuments = () =>
    run(async () => {
      setDocumentError("");
      try {
        const required = session?.order.requiredDocuments ?? [
          "PASSPORT",
          "TICKET",
        ];
        const missing = required.filter(
          (type) =>
            !files[type] &&
            !hasUploadedDocument(session?.order.documents, type),
        );
        if (missing.length)
          throw new Error(
            `Upload your ${missing.map((type) => type.toLowerCase()).join(" and ")} to continue`,
          );
        for (const type of required) {
          const file = files[type];
          if (!file) continue;
          if (file.size > 10 * 1024 * 1024)
            throw new Error(`${file.name} exceeds the 10 MB limit`);
          if (
            !["application/pdf", "image/jpeg", "image/png"].includes(
              file.type || "application/pdf",
            )
          )
            throw new Error(`${file.name} must be a PDF, JPG or PNG`);
        }
        setVerification(null);
        for (const type of required) {
          const file = files[type];
          if (!file) continue;
          const saved = await uploadDocument.current({
            type,
            file,
            basePath: `/partner-checkout/${token}/documents`,
            request: api,
            progress: setDocumentMessage,
          });
          setSession((current) =>
            current
              ? {
                  ...current,
                  order: {
                    ...current.order,
                    ...(type === "PASSPORT"
                      ? { documentReviewStatus: "NOT_STARTED" }
                      : {}),
                    documents: [
                      ...current.order.documents.filter(
                        (doc) => doc.type !== type,
                      ),
                      saved,
                    ],
                  },
                }
              : current,
          );
          setFiles((current) => ({
            ...current,
            [type]: current[type] === file ? undefined : current[type],
          }));
        }
        const refreshed = await api<Session>(`/partner-checkout/${token}`);
        setSession(refreshed);
        setEditingVerifiedDocuments(false);
        setVerification({
          status: refreshed.order.documentReviewStatus ?? "NOT_STARTED",
        });
        if (
          !refreshed.order.documentReviewStatus ||
          refreshed.order.documentReviewStatus === "NOT_STARTED"
        )
          await runVerification();
      } catch (cause) {
        setDocumentError(
          cause instanceof Error
            ? cause.message
            : "Could not save your documents. Retry to continue.",
        );
      } finally {
        setDocumentMessage("");
      }
    });

  useDocumentRefresh(
    [2, 3].includes(step) &&
      !busy &&
      !verifying &&
      ["OCR_PENDING", "OCR_BACKGROUND", "MANUAL_REVIEW"].includes(
        verification?.status ?? "",
      ),
    async (isCurrent) => {
      const refreshed = await api<Session>(`/partner-checkout/${token}`);
      if (!isCurrent()) return;
      setSession(refreshed);
      setVerification({
        status: refreshed.order.documentReviewStatus ?? "NOT_STARTED",
      });
      setDocumentError("");
    },
    () =>
      setDocumentError(
        "Connection interrupted. Your files are saved. We’ll keep trying to refresh verification.",
      ),
    verification?.status === "MANUAL_REVIEW",
  );

  useEffect(() => {
    const extraction = session?.order.passportExtraction;
    if (
      !extraction ||
      !["READY", "PARTIAL", "SKIPPED"].includes(extraction.status)
    )
      return;
    const key = `${session?.order.id}:${extraction.status}:${JSON.stringify(extraction.fields ?? {})}`;
    if (appliedExtraction.current !== key) {
      appliedExtraction.current = key;
      setTraveler((current) => {
        const updates: Partial<Traveler> = {};
        for (const [field, value] of Object.entries(extraction.fields ?? {})) {
          const key = field as keyof Traveler;
          if (typeof value === "string" && !current[key])
            Object.assign(updates, { [key]: value });
        }
        return { ...current, ...updates };
      });
    }
    if (step === 2 && verification?.status !== "REUPLOAD_REQUIRED") stepPush(3);
  }, [
    session?.order.id,
    session?.order.passportExtraction,
    verification?.status,
    step,
  ]);

  const gatePassed =
    !session ||
    session.order.orderType === "TOPUP" ||
    verification?.status === "VERIFIED" ||
    verification?.status === "MANUALLY_APPROVED" ||
    verification?.status === "SKIPPED";

  useEffect(() => {
    const current = verification?.status;
    const previous = previousVerificationStatus.current;
    previousVerificationStatus.current = current;
    if (
      previous &&
      !["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(previous) &&
      ["VERIFIED", "MANUALLY_APPROVED"].includes(current ?? "")
    )
      setSuccessMessage(
        current === "MANUALLY_APPROVED"
          ? "Our team approved your documents. You can continue to payment."
          : "Your passport was matched with your traveller details. You can continue to payment.",
      );
    if (
      current &&
      current !== previous &&
      ["CORRECTION_REQUIRED", "REUPLOAD_REQUIRED"].includes(current)
    ) {
      if (current === "CORRECTION_REQUIRED") {
        setDocumentAttentionMessage(
          "We could not confirm that the passport matches all traveller details. Review the marked fields and save again.",
        );
      } else {
        const expiredPassport =
          session?.order.passportExtraction?.failureCode ===
          "PASSPORT_EXPIRED";
        const rejected = (session?.order.documents ?? [])
          .filter((document) => document.status === "REUPLOAD_REQUIRED")
          .map((document) =>
            document.type === "PASSPORT"
              ? "passport"
              : document.type === "TICKET"
                ? "travel ticket"
                : "document",
          );
        setDocumentAttentionMessage(
          expiredPassport
            ? "This passport has expired. Upload a valid passport before continuing."
            : rejected.length
            ? `We could not confirm your ${rejected.join(" and ")}. Replace the marked file before continuing.`
            : "We could not confirm one of the uploaded documents. Replace the marked file before continuing.",
        );
      }
    }
    if (current === "REUPLOAD_REQUIRED" && current !== previous && step !== 2)
      stepJump(2);
  }, [verification?.status, step]);

  useEffect(() => {
    if (step === 3 && awaitingVerificationAdvance.current && gatePassed) {
      awaitingVerificationAdvance.current = false;
      stepPush(4);
    }
  }, [step, gatePassed]);

  useEffect(() => {
    if (
      session?.order.status === "DRAFT" &&
      step === 4 &&
      !submitted &&
      (!gatePassed || Object.values(files).some(Boolean))
    )
      stepJump(3);
  }, [step, gatePassed, session?.order.status, submitted, files]);

  const PAID_STATUSES = new Set([
    "PAYMENT_CONFIRMED",
    "REVIEW_PENDING",
    "APPROVED",
    "PROVISIONING",
    "QR_READY",
    "ACTIVATION_ATTENTION",
    "COMPLETED",
  ]);
  const FAILED_STATUSES = new Set([
    "PAYMENT_FAILED",
    "CANCELLED",
    "PROVISIONING_FAILED",
  ]);
  const external = (url: string) => {
    try {
      return new URL(url).origin !== window.location.origin;
    } catch {
      return true;
    }
  };
  const requestPayment = async () => {
    const value = await api<Payment>(`/partner-checkout/${token}/payment`, {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    setPayment(value);
    if (value.redirectUrl && external(value.redirectUrl))
      window.location.assign(value.redirectUrl);
  };
  const initiatePayment = () => run(requestPayment);
  const settleTerminalVerdict = (code?: string) => {
    // The payment session is over: expired, cancelled, a reference that does
    // not belong to the order, or one the server refuses a new attempt for.
    // Drop the dead payment so the QR can never be re-scanned and the customer
    // can see the provider choices again (the server still enforces safety).
    if (
      code === "PAYMENT_EXPIRED" ||
      code === "PAYMENT_NOT_CONFIRMED" ||
      code === "PAYMENT_REFERENCE_MISMATCH" ||
      code === "PAYMENT_RETRY_NOT_SAFE"
    ) {
      setPayment(null);
      return true;
    }
    return false;
  };
  const checkPayment = () =>
    run(async () => {
      if (paymentVerificationInFlight.current)
        throw new Error(
          "We are already checking this payment. Please wait a moment, then check again.",
        );
      try {
        const result = await api<{ status: string }>(
          `/partner-checkout/${token}/verify`,
          { method: "POST", body: "{}" },
        );
        if (PAID_STATUSES.has(result.status)) {
          setOutcome({ status: result.status, orderNumber });
          return;
        }
        if (FAILED_STATUSES.has(result.status)) {
          setPayment(null);
          return;
        }
      } catch (cause) {
        const code = (cause as { code?: string })?.code;
        if (settleTerminalVerdict(code)) {
          if (code === "PAYMENT_RETRY_NOT_SAFE") throw cause;
          setError("That payment attempt has ended. Start a new one to continue.");
          return;
        }
        throw cause;
      }
      throw new Error(
        "Your payment is still being confirmed by the gateway. Wait a moment, then check again.",
      );
    });
  const reportTelemetry = (telemetry: FonepayTelemetryPayload) =>
    postFonepayTelemetry(
      api,
      `/partner-checkout/${token}/payment/telemetry`,
      payment?.reference,
      telemetry,
    );
  const verifySilently = async () => {
    if (stoppedForVerify.current || paymentVerificationInFlight.current) return;
    paymentVerificationInFlight.current = true;
    try {
      const result = await api<{ status: string }>(
        `/partner-checkout/${token}/verify`,
        { method: "POST", body: "{}" },
      );
      if (PAID_STATUSES.has(result.status)) {
        setOutcome({ status: result.status, orderNumber });
      } else if (FAILED_STATUSES.has(result.status)) {
        setPayment(null);
      }
    } catch (cause) {
      // A settled verdict (expired/cancelled/mismatch/review) ends the
      // session; the polling effect's stoppedForVerify guard stops further
      // pings once payment is cleared. Transient errors stay available for
      // the manual "check again" action.
      if (settleTerminalVerdict((cause as { code?: string })?.code))
        fonepayExpiryChecked.current = payment?.reference ?? "";
    } finally {
      paymentVerificationInFlight.current = false;
    }
  };
  useEffect(() => {
    if (
      !payment ||
      outcome ||
      provider !== PaymentProvider.FONEPAY ||
      !payment.reference ||
      !payment.expiresAt
    )
      return;
    const expiry = new Date(payment.expiresAt).getTime();
    if (!Number.isFinite(expiry)) return;
    let timeout: number | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      timeout = window.setTimeout(poll, 5_000);
    };
    const poll = () => {
      if (stopped) return;
      if (Date.now() >= expiry) {
        if (fonepayExpiryChecked.current !== payment.reference) {
          fonepayExpiryChecked.current = payment.reference;
          void verifySilently();
        }
        return;
      }
      if (document.visibilityState === "visible") void verifySilently();
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && Date.now() < expiry)
        void verifySilently();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    payment?.reference,
    payment?.expiresAt,
    provider,
    outcome,
    orderNumber,
    token,
  ]);
  useEffect(() => {
    setFonepaySocketReady(false);
    if (!payment || outcome) return;
    let stopped = false;
    let socket: WebSocket | undefined;
    let locallyClosed = false;
    const reference = payment.reference;
    if (payment.websocketUrl) {
      const wsUrl = payment.websocketUrl;
      try {
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        let backoffMs = 1_000;
        const maxBackoffMs = 30_000;
        const maxReconnects = 5;
        let reconnects = 0;
        const scheduleReconnect = () => {
          if (stopped || locallyClosed || reconnects >= maxReconnects) return;
          reconnects += 1;
          reportTelemetry({
            event: "SOCKET_RECONNECTING",
            attempt: reconnects,
          });
          reconnectTimer = setTimeout(() => {
            backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
            connect();
          }, backoffMs);
        };
        const connect = () => {
          socket = new WebSocket(wsUrl);
          socket.onopen = () => {
            setFonepaySocketReady(true);
            if (connectTimer !== undefined) {
              clearTimeout(connectTimer);
              connectTimer = undefined;
            }
            backoffMs = 1_000;
            reconnects = 0;
            reportTelemetry({ event: "SOCKET_CONNECTED" });
          };
          socket.onerror = () => {
            setFonepaySocketReady(false);
            reportTelemetry({
              event: "SOCKET_ERROR",
              reason: "SOCKET_TRANSPORT_ERROR",
            });
            // If onclose does not follow (unreliable transport), reconnect here.
            scheduleReconnect();
          };
          socket.onclose = () => {
            setFonepaySocketReady(false);
            if (connectTimer !== undefined) {
              clearTimeout(connectTimer);
              connectTimer = undefined;
            }
            reportTelemetry({
              event: "SOCKET_CLOSED",
              reason: locallyClosed
                ? "SOCKET_LOCAL_CLOSE"
                : "SOCKET_REMOTE_CLOSE",
            });
            if (!locallyClosed) scheduleReconnect();
          };
          socket.onmessage = (event) => {
            const signal = fonepaySocketSignal(event.data);
            if (signal === "QR_VERIFIED") {
              reportTelemetry({ event: "QR_VERIFIED_SIGNAL" });
              setFonepayBankHint(
                "QR recognized. Complete the payment in your banking app.",
              );
              void verifySilently();
              return;
            }
            if (signal === "PAYMENT_RESULT") {
              reportTelemetry({ event: "PAYMENT_RESULT_SIGNAL" });
              locallyClosed = true;
              socket?.close();
              void verifySilently();
            }
          };
        };
        connect();
        connectTimer = setTimeout(scheduleReconnect, 15_000);
        return () => {
          stopped = true;
          locallyClosed = true;
          clearTimeout(reconnectTimer);
          if (connectTimer !== undefined) clearTimeout(connectTimer);
          socket?.close();
        };
      } catch {
        // The provider status endpoint remains authoritative.
      }
    }
    return () => {
      stopped = true;
      locallyClosed = true;
      socket?.close();
    };
  }, [payment, outcome, orderNumber, token]);
  useEffect(() => {
    if (!payment?.reference || outcome) return;
    if (provider !== PaymentProvider.FONEPAY) return;
    reportTelemetry({ event: "QR_RENDERED" });
  }, [payment?.reference, provider, outcome]);
  const simulatePayment = () =>
    run(async () => {
      const result = await api<{ status: string }>(
        `/partner-checkout/${token}/payment/simulate-complete`,
        { method: "POST", body: "{}" },
      );
      if (PAID_STATUSES.has(result.status)) {
        setOutcome({ status: result.status, orderNumber });
        return;
      }
      throw new Error(`Simulated payment did not complete (${result.status})`);
    });
  const complete = () =>
    run(async () => {
      if ((!isTopUp && !compatibilityConsent) || !legalConsent)
        throw new Error(
          "Complete the required confirmations before continuing",
        );
      if (!gatePassed) throw new Error("Verify your documents before paying");
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
      setOrderNumber(result.orderNumber);
      setSubmitted(true);
      await requestPayment();
    });

  const transitionRef = useCheckoutTransition(
    `${step}:${showAccountChoice}`,
    Boolean(session) && !busy,
  );
  if (
    loadFailed ||
    (session && session.order.status !== "DRAFT" && !submitted && !outcome)
  )
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
      <main
        className="checkout-page checkout-loading-surface"
        aria-busy="true"
        aria-label="Loading secure checkout"
        role="status"
      >
        <LoaderCircle
          className="spin checkout-loading-indicator"
          aria-hidden="true"
        />
      </main>
    );

  const plan = session!.order.plan;
  const isTopUp = session!.order.orderType === "TOPUP";
  return (
    <main className="checkout-page">
      <ErrorModal error={error || null} onClose={() => setError("")} />
      {successMessage && (
        <ErrorModal
          error={successMessage}
          title="Verification complete"
          tone="success"
          onClose={() => setSuccessMessage("")}
        />
      )}
      {documentAttentionMessage && (
        <ErrorModal
          error={documentAttentionMessage}
          title="Document check needs attention"
          onClose={() => setDocumentAttentionMessage("")}
        />
      )}
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
          <section className="checkout-card" ref={transitionRef}>
            {checkoutAccessMode === "guest" && !outcome && (
              <div className="guest-recovery-card" role="note">
                <span className="guest-recovery-icon">
                  <Link2 />
                </span>
                <div>
                  <b>Keep this private partner checkout link</b>
                  <p>
                    Bookmark or copy this link before closing the tab. It lets
                    you return to this order and check its verification status.
                  </p>
                  <small>
                    Anyone with this link can access the hosted checkout, so do
                    not share it.
                  </small>
                  <div className="guest-recovery-actions">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => void copyHostedCheckoutLink()}
                    >
                      <Copy size={16} />{" "}
                      {copiedCheckoutLink ? "Link copied" : "Copy private link"}
                    </button>
                  </div>
                  <span className="sr-only" aria-live="polite">
                    {copiedCheckoutLink
                      ? "Private partner checkout link copied"
                      : ""}
                  </span>
                </div>
              </div>
            )}
            {!showAccountChoice && !outcome && (
              <div className="step-tabs">
                {(isTopUp
                  ? ["Recharge", "Payment"]
                  : ["Compatibility", "Documents", "Traveller", "Payment"]
                ).map((label, index) => {
                  const value = isTopUp ? (index === 0 ? 1 : 4) : index + 1;
                  return (
                    <div
                      key={label}
                      className={
                        (submitted ? 4 : step) === value
                          ? "active"
                          : (submitted ? 4 : step) > value
                            ? "done"
                            : ""
                      }
                    >
                      <i>
                        {(submitted ? 4 : step) > value ? (
                          <Check size={13} />
                        ) : (
                          value
                        )}
                      </i>
                      {!submitted && step > value ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => stepJump(value)}
                          title={`Go back to ${label}`}
                        >
                          <span>{label}</span>
                        </button>
                      ) : (
                        <span>{label}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {showAccountChoice ? (
              <div
                className="form-section account-choice"
                aria-labelledby="hosted-account-title"
              >
                <span className="form-icon">
                  <UserRound />
                </span>
                <h2 id="hosted-account-title">
                  How would you like to continue?
                </h2>
                <p>
                  Sign in to keep this partner order in My eSIMs and check its
                  status from any device.
                </p>
                <div className="account-choice-grid">
                  <div className="account-choice-primary">
                    <span className="choice-badge">Recommended</span>
                    <b>Continue with an account</b>
                    <small>
                      Secure cross-device access and a permanent order history,
                      while keeping the partner attribution.
                    </small>
                    {isSignedIn === true ? (
                      <button
                        className="button wide"
                        disabled={busy}
                        onClick={() => void continueWithAccount()}
                      >
                        Continue with my account <ChevronRight size={18} />
                      </button>
                    ) : (
                      <SignInButton mode="modal">
                        <button
                          className="button wide"
                          disabled={busy}
                          onClick={() => setPendingSignIn(true)}
                        >
                          Sign in or create account <ChevronRight size={18} />
                        </button>
                      </SignInButton>
                    )}
                  </div>
                  <div className="account-choice-guest">
                    <b>Continue as guest</b>
                    <small>
                      No account required. Keep this private partner link so you
                      can return to the order.
                    </small>
                    <button
                      className="button secondary wide"
                      disabled={busy}
                      onClick={() => advanceAfterAccountChoice("guest")}
                    >
                      Continue as guest
                    </button>
                  </div>
                </div>
                <button
                  className="account-choice-back"
                  type="button"
                  onClick={() => setShowAccountChoice(false)}
                >
                  <ChevronLeft size={16} /> Back to compatibility
                </button>
              </div>
            ) : outcome ? (
              <div className="form-section">
                <div
                  className={
                    outcome.status === "PAYMENT_PENDING" ||
                    PAID_STATUSES.has(outcome.status)
                      ? "success-panel"
                      : "error-panel"
                  }
                >
                  {PAID_STATUSES.has(outcome.status) ? (
                    <>
                      <CheckCircle2 size={42} />
                      <b>Payment confirmed</b>
                      <span>{outcome.orderNumber}</span>
                      <p>
                        Thanks! Your order is paid and the partner is activating
                        your eSIM. The activation QR will be shared with you
                        shortly.
                      </p>
                    </>
                  ) : outcome.status === "PAYMENT_PENDING" ? (
                    <>
                      <LoaderCircle className="spin" size={42} />
                      <b>Payment pending</b>
                      <span>{outcome.orderNumber}</span>
                      <p>
                        We couldn&apos;t get a final confirmation from the
                        payment provider. If you were asked to complete a
                        payment, check again in a moment.
                      </p>
                      <button
                        className="button primary"
                        onClick={checkPayment}
                        disabled={busy}
                      >
                        {busy ? (
                          <LoaderCircle className="spin" size={18} />
                        ) : (
                          "Check again"
                        )}
                      </button>
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={42} />
                      <b>Your order could not be activated</b>
                      <span>{outcome.orderNumber}</span>
                      <p>
                        Your payment was received but activation did not
                        complete. The partner team is reviewing it and will
                        contact you about next steps.
                      </p>
                    </>
                  )}
                </div>
              </div>
            ) : submitted || step === 4 ? (
              <div className="form-section">
                <span className="form-icon">
                  <LockKeyhole />
                </span>
                <h2>
                  Pay {session!.order.currency}{" "}
                  {session!.order.amountNpr.toLocaleString()}
                </h2>
                <p>
                  {orderNumber || session!.order.orderNumber} · Choose how you
                  would like to pay.
                </p>
                {!submitted && (
                  <>
                    {!isTopUp &&
                      !gatePassed &&
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
                          onEdit={() => stepJump(3)}
                        />
                      ))}
                    {isTopUp && (
                      <p className="form-note">
                        This is a data top-up for your existing eSIM
                        {session!.order.topUpMsisdnMasked
                          ? ` with mobile number ${session!.order.topUpMsisdnMasked}`
                          : ""}
                        . No traveller details or new documents are required.
                      </p>
                    )}
                    {isTopUp && (
                      <PurchaseConsent
                        checked={legalConsent}
                        onChange={setLegalConsent}
                        recharge
                        compact
                      />
                    )}
                  </>
                )}
                {!payment ? (
                  lockedProvider ? (
                    <div className="gateway-grid chosen-provider">
                      <div className="chosen-provider-card">
                        <img
                          src={
                            lockedProvider === PaymentProvider.FONEPAY
                              ? "/brand/fonepay-logo.png"
                              : "/brand/khalti-logo.png"
                          }
                          alt={
                            lockedProvider === PaymentProvider.FONEPAY
                              ? "Checkout by Fonepay"
                              : "Khalti"
                          }
                        />
                        <span className="gateway-copy">
                          <b>
                            {lockedProvider === PaymentProvider.FONEPAY
                              ? "Mobile banking"
                              : "Khalti wallet"}
                          </b>
                          <small>
                            {lockedProvider === PaymentProvider.FONEPAY
                              ? "Pay with any supported banking app or scan the QR."
                              : "Pay from your Khalti balance."}
                          </small>
                        </span>
                        <button
                          type="button"
                          className="change-provider"
                          onClick={() => setLockedProvider(null)}
                        >
                          Change
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="gateway-grid payment-gateway-grid">
                      <button
                        type="button"
                        className={`khalti-provider ${provider === PaymentProvider.KHALTI ? "selected" : ""}`}
                        onClick={() => {
                          setProvider(PaymentProvider.KHALTI);
                          setLockedProvider(PaymentProvider.KHALTI);
                        }}
                      >
                        <img src="/brand/khalti-logo.png" alt="Khalti" />
                        <span className="gateway-copy">
                          <b>Khalti wallet</b>
                          <small>
                            Use when you want to pay from your Khalti balance.
                          </small>
                        </span>
                      </button>
                      {availableProviders.includes(PaymentProvider.FONEPAY) ? (
                        <button
                          type="button"
                          className={`fonepay-provider ${provider === PaymentProvider.FONEPAY ? "selected" : ""}`}
                          onClick={() => {
                            setProvider(PaymentProvider.FONEPAY);
                            setLockedProvider(PaymentProvider.FONEPAY);
                          }}
                        >
                          <img
                            src="/brand/fonepay-logo.png"
                            alt="Checkout by Fonepay"
                          />
                          <span className="gateway-copy">
                            <b>Mobile banking</b>
                            <small>
                              Use any supported banking app or scan the QR.
                            </small>
                          </span>
                        </button>
                      ) : null}
                    </div>
                  )
                ) : null}
                {payment ? (
                  SIMULATOR ? (
                    <div className="simulator-box">
                      <span>Local signed simulator</span>
                      <small>
                        Reference: {payment.reference.slice(0, 14)}...
                      </small>
                      <Action busy={busy} onClick={simulatePayment}>
                        Simulate verified payment
                      </Action>
                    </div>
                  ) : payment.qrDataUrl || payment.qrPayload ? (
                    <FonepayCheckout
                      titleId="hosted-fonepay-checkout-title"
                      banks={
                        provider === PaymentProvider.FONEPAY
                          ? payment.banks
                          : undefined
                      }
                      qrPayload={payment.qrPayload}
                      qrDataUrl={payment.qrDataUrl}
                      socketReady={fonepaySocketReady}
                      onError={setError}
                      onTelemetry={(event) => reportTelemetry(event)}
                      hint={fonepayBankHint}
                      busy={busy}
                      checkLabel="I&apos;ve completed payment - check status"
                      onCheck={checkPayment}
                    />
                  ) : (
                    <Action busy={busy} onClick={checkPayment}>
                      I&apos;ve paid — check status
                    </Action>
                  )
                ) : (
                  <>
                    <Action
                      busy={busy}
                      disabled={
                        !submitted &&
                        (verifying ||
                          !gatePassed ||
                          !legalConsent ||
                          (!isTopUp && !compatibilityConsent))
                      }
                      onClick={submitted ? initiatePayment : complete}
                    >
                      Continue to{" "}
                      {provider === PaymentProvider.FONEPAY
                        ? "Fonepay"
                        : "Khalti"}
                    </Action>
                    {!submitted && (
                      <div className="form-actions">
                        <button
                          className="button secondary"
                          onClick={() => stepJump(isTopUp ? 1 : 3)}
                        >
                          <ChevronLeft size={16} />{" "}
                          {isTopUp ? "Back" : "Traveller details"}
                        </button>
                      </div>
                    )}
                    {submitted && (
                      <div className="form-actions">
                        <button
                          className="button secondary"
                          onClick={checkPayment}
                          disabled={busy}
                        >
                          I&apos;ve already paid — check status
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <>
                {step === 1 && (
                  <div className="form-section">
                    <span className="form-icon">
                      <ShieldCheck />
                    </span>
                    <h1>
                      {isTopUp ? "Your eSIM recharge" : "Device compatibility"}
                    </h1>
                    <p>
                      {isTopUp
                        ? "Add data to your existing eSIM. You will confirm the purchase terms when you pay."
                        : "Your phone must support eSIM and be carrier-unlocked. Coverage starts after first connection at your destination."}
                    </p>
                    {!isTopUp && (
                      <>
                        <CompatibilityConfirmation
                          checked={compatibilityConsent}
                          onChange={(checked) => {
                            setCompatibilityConsent(checked);
                            clearSavedConsent();
                          }}
                        />
                        <PurchaseConsent
                          checked={legalConsent}
                          onChange={(accepted) => {
                            setLegalConsent(accepted);
                            clearSavedConsent();
                          }}
                        />
                      </>
                    )}
                    <Nav
                      back={() => {}}
                      backHidden
                      busy={busy}
                      disabled={
                        !isTopUp && (!compatibilityConsent || !legalConsent)
                      }
                      next={() =>
                        run(async () => {
                          if (
                            !isTopUp &&
                            (!compatibilityConsent || !legalConsent)
                          )
                            throw new Error(
                              "Confirm device compatibility and accept the purchase terms first",
                            );
                          if (!isTopUp) {
                            try {
                              window.sessionStorage.setItem(
                                consentKey,
                                "accepted",
                              );
                            } catch {
                              /* Consent remains valid for this page session. */
                            }
                          }
                          if (isSignedIn === true) await continueWithAccount();
                          else setShowAccountChoice(true);
                        })
                      }
                    />
                  </div>
                )}
                {step === 3 && (
                  <div className="form-section">
                    <span className="form-icon">
                      <UserRound />
                    </span>
                    <h1>Traveller information</h1>
                    <p>
                      We used your passport to prefill what we could. Check
                      every detail, complete the remaining fields, and use
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
                      <Field
                        label="Middle name (optional)"
                        error={fieldErrors.middleName}
                      >
                        <input
                          name="middleName"
                          autoComplete="additional-name"
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
                    {(Boolean(documentMessage) ||
                      [
                        "OCR_PENDING",
                        "OCR_BACKGROUND",
                        "MANUAL_REVIEW",
                      ].includes(verification?.status ?? "")) && (
                      <PassportCheck
                        status={
                          documentMessage &&
                          ![
                            "CORRECTION_REQUIRED",
                            "MANUAL_REVIEW",
                            "VERIFIED",
                            "MANUALLY_APPROVED",
                            "SKIPPED",
                          ].includes(verification?.status ?? "")
                            ? "OCR_PENDING"
                            : verification?.status
                        }
                        busy={busy}
                        onRecheck={() =>
                          void run(async () => void (await runVerification()))
                        }
                      />
                    )}
                  </div>
                )}
                {step === 2 && (
                  <div className="form-section">
                    <span className="form-icon">
                      <FileCheck2 />
                    </span>
                    <h2>Travel documents</h2>
                    <p>
                      To meet customer identification requirements applicable to
                      Visa Compass in Nepal, we verify the traveller using a
                      valid passport. Your encrypted information is used only
                      for verification, order fulfilment, and applicable
                      record-keeping.
                    </p>
                    {!["CORRECTION_REQUIRED", "REUPLOAD_REQUIRED"].includes(
                      verification?.status ?? "",
                    ) && (
                      <DocumentProgress
                        status={
                          Object.values(files).some(Boolean)
                            ? "NOT_STARTED"
                            : verification?.status
                        }
                        busy={busy || verifying}
                        message={documentError || documentMessage}
                      />
                    )}
                    {gatePassed && !editingVerifiedDocuments ? (
                      <>
                        <VerifiedDocumentsSummary
                          documents={session?.order.documents}
                          reviewStatus={verification?.status}
                        />
                        <div className="form-actions verified-document-actions">
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => setEditingVerifiedDocuments(true)}
                          >
                            Change documents
                          </button>
                          <button
                            type="button"
                            className="button primary"
                            onClick={() => stepPush(3)}
                          >
                            Review traveller details
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {verification?.status !== "REUPLOAD_REQUIRED" && (
                          <SavedDocuments
                            documents={session?.order.documents}
                          />
                        )}
                        {![
                          "OCR_PENDING",
                          "OCR_BACKGROUND",
                          "CORRECTION_REQUIRED",
                          "MANUAL_REVIEW",
                        ].includes(verification?.status ?? "") && (
                          <>
                            {editingVerifiedDocuments && (
                              <p className="document-change-warning">
                                Replacing your passport starts verification
                                again.
                              </p>
                            )}
                            {verification?.status === "REUPLOAD_REQUIRED" ? (
                              <DocumentRecoveryFields
                                documents={session?.order.documents}
                                types={session!.order.requiredDocuments}
                                files={files}
                                onChange={(type, file) =>
                                  setFiles((current) => ({
                                    ...current,
                                    [type]: file,
                                  }))
                                }
                                disabled={busy}
                              />
                            ) : (
                              <fieldset
                                className="upload-list document-fields"
                                disabled={busy}
                              >
                                {session!.order.requiredDocuments.map(
                                  (type) => (
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
                                      savedName={
                                        session?.order.documents.find(
                                          (doc) =>
                                            doc.type === type &&
                                            doc.uploadVerified,
                                        )?.fileName
                                      }
                                      onChange={(v) =>
                                        setFiles((f) => ({ ...f, [type]: v }))
                                      }
                                    />
                                  ),
                                )}
                              </fieldset>
                            )}
                          </>
                        )}
                        <div className="form-actions">
                          <button
                            type="button"
                            className="button secondary"
                            disabled={busy || verifying}
                            onClick={() => {
                              if (editingVerifiedDocuments) {
                                setFiles({});
                                setEditingVerifiedDocuments(false);
                              } else if (
                                [
                                  "REUPLOAD_REQUIRED",
                                  "CORRECTION_REQUIRED",
                                ].includes(verification?.status ?? "") &&
                                session?.order.travelerComplete
                              )
                                stepPush(3);
                              else stepJump(1);
                            }}
                          >
                            {editingVerifiedDocuments
                              ? "Cancel changes"
                              : [
                                    "REUPLOAD_REQUIRED",
                                    "CORRECTION_REQUIRED",
                                  ].includes(verification?.status ?? "") &&
                                  session?.order.travelerComplete
                                ? "Check traveller details"
                                : "Back"}
                          </button>
                          <button
                            type="button"
                            className="button primary"
                            disabled={
                              busy ||
                              verifying ||
                              (editingVerifiedDocuments &&
                                !Object.values(files).some(Boolean)) ||
                              (!Object.values(files).some(Boolean) &&
                                [
                                  "OCR_PENDING",
                                  "OCR_BACKGROUND",
                                  "CORRECTION_REQUIRED",
                                  "MANUAL_REVIEW",
                                ].includes(verification?.status ?? "")) ||
                              (!Object.values(files).some(Boolean) &&
                                verification?.status === "REUPLOAD_REQUIRED")
                            }
                            onClick={() => void saveDocuments()}
                          >
                            {busy
                              ? "Saving documents…"
                              : editingVerifiedDocuments
                                ? "Save changes"
                                : !Object.values(files).some(Boolean) &&
                                    verification?.status === "MANUAL_REVIEW"
                                  ? "Awaiting approval"
                                  : !Object.values(files).some(Boolean) &&
                                      [
                                        "OCR_PENDING",
                                        "OCR_BACKGROUND",
                                      ].includes(verification?.status ?? "")
                                    ? "Verification in progress"
                                    : verification?.status ===
                                        "REUPLOAD_REQUIRED"
                                      ? files.PASSPORT
                                        ? "Check new passport"
                                        : Object.values(files).some(Boolean)
                                          ? "Save document changes"
                                          : "Choose a passport or change details"
                                      : "Save documents"}
                          </button>
                        </div>
                      </>
                    )}
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
                  {plan.countryCode} · {formatPlanDataText(plan.dataAllowance)}
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
                {formatPlanDataText(plan.dataAllowance)} · {plan.validityDays}{" "}
                days
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
  disabled?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      className="button wide"
      disabled={busy || disabled}
      onClick={onClick}
    >
      {busy ? (
        <>
          <LoaderCircle className="spin" size={18} />
          {children}
        </>
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
  disabled,
}: {
  back: () => void;
  busy: boolean;
  next: () => void;
  backHidden?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="form-actions">
      {!backHidden && (
        <button type="button" className="button secondary" onClick={back}>
          Back
        </button>
      )}
      <Action busy={busy} disabled={disabled} onClick={next}>
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
  if (status === "CORRECTION_REQUIRED")
    return (
      <div className="passport-check warning" role="status">
        <AlertTriangle size={20} />
        <span>
          <b>Recheck your traveller details</b>
          <small>
            We couldn't automatically match some details with your uploaded
            passport. Please check the highlighted fields.
          </small>
        </span>
      </div>
    );
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
  if (status === "MANUALLY_APPROVED")
    return (
      <div className="passport-check verified">
        <CheckCircle2 size={20} />
        <span>
          <b>Documents approved</b>
          <small>Your documents were reviewed and approved.</small>
        </span>
      </div>
    );
  if (status === "MANUAL_REVIEW")
    return (
      <div className="passport-check manual" role="status">
        <ShieldCheck size={20} />
        <span>
          <b>Your documents are being reviewed</b>
          <small>
            We could not automatically confirm your corrected details. Your
            documents have been sent for review. You do not need to upload them
            again unless requested.
          </small>
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
