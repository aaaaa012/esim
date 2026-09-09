"use client";
import { orderStatusLabel } from "@visa-compass/shared";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { SignInButton, useAuth } from "@clerk/nextjs";

import { useEffect, useRef, useState } from "react";
import ErrorModal from "../../../components/error-modal";
import { formatPlanDataText } from "../../../lib/format-data";
import { filterFonepayBanks, fonepayBankIntentUrl } from "./payment-intent";
import { paymentActionDisabled } from "./payment-gates";
import Link from "next/link";
import {
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
  AlertTriangle,
  Copy,
  Link2,
  UserRound,
} from "lucide-react";
import { flagEmoji } from "../../country-picker";
import {
  DocumentProgress,
  SavedDocuments,
  VerifiedDocumentsSummary,
  hasSavedDocument,
  hasUploadedDocument,
} from "./document-progress";
import { createDocumentUploader } from "./document-upload";
import { useDocumentRefresh } from "./use-document-refresh";
import { DocumentFileField as FileField } from "./document-file-field";
import { DocumentRecoveryFields } from "./document-recovery";
import {
  CompatibilityConfirmation,
  PurchaseConsent,
} from "./checkout-confirmation";
import { useCheckoutTransition } from "./use-checkout-transition";
import DatePicker from "./date-picker";
import { submitCheckoutDocumentsSequentially } from "./document-submission";
import {
  checkoutResumeDisposition,
  checkoutResumeStep,
  paymentStatusHeading,
} from "./checkout-resume";
import {
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
  documents?: {
    type: string;
    status: string;
    fileName?: string;
    uploadVerified?: boolean;
  }[];
  payment?: {
    provider?: PaymentProvider;
    reference: string;
    status: string;
  };
  passportVerification?: {
    status: string;
    matchedFields?: string[];
    confidence?: number;
    checkedAt?: string;
    method?: string;
    detail?: string;
  };
  documentReviewStatus?:
    | "NOT_STARTED"
    | "OCR_PENDING"
    | "OCR_BACKGROUND"
    | "VERIFIED"
    | "MANUAL_REVIEW"
    | "REUPLOAD_REQUIRED"
    | "MANUALLY_APPROVED"
    | "SKIPPED";
  refundStatus?: string;
  provisioningFailure?: { code: string; message: string };
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
  rechargeTargetLabel,
}: {
  planId: string;
  orderId: string;
  mobile?: string;
  lookupToken?: string;
  targetEsimId?: string;
  targetCountry?: string;
  rechargeTargetLabel?: string;
}) {
  const authFetch = useAuthenticatedFetch();
  const rechargeMode = useRef(
    Boolean(lookupToken || targetEsimId) ||
      (typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("recharge") === "1"),
  );
  const { isLoaded, isSignedIn } = useAuth();
  const tokenKey = (id?: string) => `vc_guest_token_${id || orderId || "new"}`;
  const readToken = (id?: string) => {
    let t = "";
    try {
      t = sessionStorage.getItem(tokenKey(id)) ?? "";
    } catch {
      t = "";
    }
    if (t) return t;
    return "";
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
  };
  const [guest, setGuest] = useState<boolean>(() => Boolean(readToken()));
  const guestRef = useRef(guest);
  guestRef.current = guest;
  useEffect(() => {
    if (!isLoaded) return;
    if (currentToken()) return;
    if (isSignedIn === true) {
      setGuest(false);
      guestRef.current = false;
    }
  }, [isLoaded, isSignedIn]);
  const [showAccountChoice, setShowAccountChoice] = useState(false);
  const [pendingSignIn, setPendingSignIn] = useState(false);
  const [claimIntent, setClaimIntent] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [recovery, setRecovery] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(!orderId);
  const recoveryKey = (id: string) => `vc_guest_recovery_${id}`;
  const consentKey = `vc_checkout_consent:v1:${orderId || planId || "checkout"}`;
  const storeRecovery = (id: string, token: string, expiresAt: string) => {
    const value = { token, expiresAt };
    setRecovery(value);
    try {
      // A recovery token is a bearer credential. Keep it only for this tab;
      // cross-device and closed-tab recovery must use the copied/emailed link.
      sessionStorage.setItem(recoveryKey(id), JSON.stringify(value));
    } catch {
      /* sessionStorage unavailable; the copyable link remains usable */
    }
  };

  const mutationKey = (scope: string) => {
    const storageKey = `vc_mutation_${scope}`;
    try {
      const existing = sessionStorage.getItem(storageKey);
      if (existing) return { key: existing, storageKey };
      const key = crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      return { key, storageKey };
    } catch {
      return { key: crypto.randomUUID(), storageKey: "" };
    }
  };
  const releaseMutationKey = (storageKey: string) => {
    if (!storageKey) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* sessionStorage unavailable */
    }
  };

  const api = async <T,>(path: string, init?: RequestInit) => {
    const rechargeRequest =
      rechargeMode.current && path.startsWith("/customer/orders");
    let url = `${API}${
      rechargeRequest
        ? path
            .replace("/customer/orders", "/recharges")
            .replace(/\/payment$/, "/payment/initiate")
            .replace("/simulate-complete", "/simulate")
        : path
    }`;
    let body = init?.body as BodyInit | null | undefined;
    const isGet = !init?.method || init.method.toUpperCase() === "GET";
    const currentGuest = guestRef.current;
    let guestHeaderToken =
      currentGuest || rechargeRequest ? currentToken() : "";
    const toGuest = () => {
      const token = currentToken();
      guestHeaderToken = token;
      url = url.replace(`${API}/customer/orders`, `${API}/guest/orders`);
      return token;
    };
    const method = init?.method?.toUpperCase() ?? "GET";
    let mutation = isGet
      ? null
      : mutationKey(`${currentGuest ? "guest" : "customer"}:${method}:${path}`);
    const makeInit = () => ({
      ...init,
      ...(body !== undefined ? { body } : {}),
      headers: {
        "content-type": "application/json",
        ...(mutation ? { "x-idempotency-key": mutation.key } : {}),
        ...(guestHeaderToken
          ? { "x-guest-order-token": guestHeaderToken }
          : {}),
        ...init?.headers,
      },
    });
    if (currentGuest && !rechargeRequest) toGuest();
    let response = await authFetch(url, makeInit());
    let payload = (await response.json()) as Envelope<T>;
    if (
      (payload.data as { purchaseType?: string } | undefined)?.purchaseType ===
      "TOPUP"
    )
      rechargeMode.current = true;
    if (mutation && response.ok) releaseMutationKey(mutation.storageKey);
    if (
      !rechargeRequest &&
      !response.ok &&
      isLoaded &&
      isSignedIn !== true &&
      [
        "AUTHENTICATION_REQUIRED",
        "FORBIDDEN",
        "ACCOUNT_TYPE_FORBIDDEN",
      ].includes(payload.error?.code ?? "") &&
      currentToken()
    ) {
      toGuest();
      mutation = isGet ? null : mutationKey(`guest:${method}:${path}`);
      setGuest((g) => {
        const next = g || true;
        guestRef.current = next;
        return next;
      });
      response = await authFetch(url, makeInit());
      payload = (await response.json()) as Envelope<T>;
      if (mutation) releaseMutationKey(mutation.storageKey);
    }
    if (!response.ok) {
      const error = new Error(
        apiErrorMessage(
          payload.error?.code ?? "",
          "This request could not be completed. Please try again.",
        ),
      ) as Error & { code?: string; status?: number };
      if (payload.error?.code) error.code = payload.error.code;
      error.status = response.status;
      throw error;
    }
    return payload.data;
  };

  // A top-up or payment-provider return starts at payment immediately so the
  // new-purchase compatibility form never flashes before effects run.
  const isTopUpIntent =
    Boolean((mobile && lookupToken) || targetEsimId) && !orderId;
  const [step, setStep] = useState(() => (orderId || isTopUpIntent ? 4 : 1)),
    [compatible, setCompatible] = useState(() => {
      try {
        return sessionStorage.getItem(consentKey) === "accepted";
      } catch {
        return false;
      }
    }),
    [legalAccepted, setLegalAccepted] = useState(() => {
      try {
        return sessionStorage.getItem(consentKey) === "accepted";
      } catch {
        return false;
      }
    }),
    [traveler, setTraveler] = useState(initial);
  const [previewPlan, setPreviewPlan] = useState<PlanSummary | null>(null);
  const [planLoadFailed, setPlanLoadFailed] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof Traveler, string>>
  >({});
  // A top-up lookup supplies a short-lived token, eSIM MSISDN, and the
  // eSIM's country. Treat that as a top-up from the first render so the
  // normal purchase form never flashes while the plan preview is loading.
  // The API independently verifies that the selected plan is valid for this
  // eSIM before it creates the order.
  useEffect(() => {
    if (!planId || orderId) return;
    let cancelled = false;
    fetch(`${API}/public/plans/${encodeURIComponent(planId)}`)
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("catalog unavailable")),
      )
      .then((data: Envelope<PlanSummary>) => {
        if (cancelled) return;
        if (data.data) setPreviewPlan(data.data);
        else setPlanLoadFailed(true);
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
  const [editingVerifiedDocuments, setEditingVerifiedDocuments] =
    useState(false);
  const [order, setOrder] = useState<Order | null>(null),
    [payment, setPayment] = useState<Payment | null>(null),
    [uxResending, setUxResending] = useState(false);
  const [resumingOrder, setResumingOrder] = useState(Boolean(orderId));
  useEffect(() => {
    try {
      if (compatible && legalAccepted)
        sessionStorage.setItem(consentKey, "accepted");
      else sessionStorage.removeItem(consentKey);
    } catch {
      /* sessionStorage unavailable */
    }
  }, [compatible, legalAccepted, consentKey]);
  useEffect(() => {
    if (!orderId) {
      setRecoveryReady(true);
      return;
    }
    let cancelled = false;
    const restore = async () => {
      let saved: { token: string; expiresAt?: string } | null = null;
      try {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const fragmentToken = fragment.get("resume");
        if (fragmentToken) {
          saved = { token: fragmentToken };
          window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${window.location.search}`,
          );
        } else {
          const stored = sessionStorage.getItem(recoveryKey(orderId));
          saved = stored ? (JSON.parse(stored) as typeof saved) : null;
        }
      } catch {
        saved = null;
      }
      if (!saved?.token) {
        if (!cancelled) setRecoveryReady(true);
        return;
      }
      if (saved.expiresAt)
        setRecovery({ token: saved.token, expiresAt: saved.expiresAt });
      if (currentToken()) {
        if (!cancelled) {
          setGuest(true);
          guestRef.current = true;
          setRecoveryReady(true);
        }
        return;
      }
      try {
        const response = await fetch(`${API}/guest/orders/${orderId}/recover`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: saved.token }),
        });
        const payload = (await response.json()) as Envelope<{
          order: Order;
          token: string;
          recoveryExpiresAt: string;
        }>;
        if (!response.ok || !payload.data)
          throw new Error(
            apiErrorMessage(
              payload.error?.code ?? "UNEXPECTED",
              "This recovery link is invalid or expired",
            ),
          );
        if (cancelled) return;
        setGuest(true);
        guestRef.current = true;
        storeGuestToken(payload.data.token, orderId);
        storeRecovery(orderId, saved.token, payload.data.recoveryExpiresAt);
        if (payload.data.order.purchaseType === "TOPUP")
          rechargeMode.current = true;
        setOrder(payload.data.order);
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : "This recovery link is invalid or expired",
          );
      } finally {
        if (!cancelled) setRecoveryReady(true);
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [orderId]);
  const verifyRunToken = useRef(0);
  const passportRetryNoBefore = useRef(0);
  const resendQrEmail = async () => {
    if (!order || uxResending) return;
    setUxResending(true);
    try {
      await api(`/customer/orders/${order.id}/resend-qr`, { method: "POST" });
    } finally {
      setUxResending(false);
    }
  };
  useEffect(
    () => () => {
      verifyRunToken.current += 1;
    },
    [],
  );
  // History-aware wizard: each user-driven step advance records the step in the
  // URL via pushState so the browser Back/Forward move between checkout steps
  // (instead of exiting the page), and the on-page Back button shares the same
  // stack. Programmatic/mount transitions still use setStep directly.
  const stepFromUrl = () => {
    const value = Number(
      new URLSearchParams(window.location.search).get("step"),
    );
    return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1;
  };
  const navigateStep = (next: number, mode: "push" | "replace") => {
    const normalized = Math.min(4, Math.max(1, next));
    if (typeof window === "undefined") {
      setStep(normalized);
      return;
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("step", String(normalized));
      window.history[mode === "push" ? "pushState" : "replaceState"](
        { ...window.history.state, checkout: true, step: normalized },
        "",
        url.toString(),
      );
    } catch {
      /* history unavailable */
    }
    setStep(normalized);
  };
  const advance = (next: number) => navigateStep(next, "push");
  const goBack = () => navigateStep(step - 1, "replace");
  // Backward navigation replaces the current entry so browser Back cannot
  // immediately send the user forward in the checkout again.
  const jumpTo = (next: number) => navigateStep(next, "replace");
  useEffect(() => {
    const onPop = () => {
      const requested = Math.min(4, Math.max(1, stepFromUrl()));
      const furthest = order ? checkoutResumeStep(order) : step;
      setStep(Math.min(requested, furthest));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [order, step]);
  useEffect(() => {
    navigateStep(step, "replace");
  }, []);
  useEffect(() => {
    const hasUnsavedCheckoutProgress = step > 1 && step < 4 && !resumingOrder;
    if (!hasUnsavedCheckoutProgress) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [resumingOrder, step]);
  const summaryPlan = order?.plan ?? previewPlan;
  const isTopUp = order?.purchaseType === "TOPUP" || isTopUpIntent;
  const [provider, setProvider] = useState<PaymentProvider>(
      PaymentProvider.KHALTI,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [verifying, setVerifying] = useState(false);
  const [verifyingPassport, setVerifyingPassport] = useState(false);
  const [fonepayBankQuery, setFonepayBankQuery] = useState("");
  const [availableProviders, setAvailableProviders] = useState<
    PaymentProvider[]
  >([PaymentProvider.KHALTI]);
  useEffect(() => {
    void api<{ providers: PaymentProvider[] }>("/payments/providers")
      .then((value) => {
        if (!value.providers.length) return;
        setAvailableProviders(value.providers);
        if (!value.providers.includes(provider))
          setProvider(value.providers[0]!);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!isTopUpIntent) return;
    setCompatible(true);
    setStep(4);
  }, [isTopUpIntent]);
  useEffect(() => {
    if (!orderId) {
      setResumingOrder(false);
      return;
    }
    if (!recoveryReady) return;
    if (!isLoaded && !guestToken) return;
    setResumingOrder(true);
    setBusy(true);
    api<Order>(`/customer/orders/${orderId}`)
      .then((value) => {
        const disposition = checkoutResumeDisposition(value.status);
        if (disposition === "UNSUPPORTED")
          throw new Error("This order can no longer be resumed from checkout");
        setOrder(value);
        setCompatible(true);
        setLegalAccepted(true);
        if (value.payment?.provider) setProvider(value.payment.provider);
        if (value.traveler) setTraveler({ ...initial, ...value.traveler });
        const resumeStep = checkoutResumeStep(value);
        navigateStep(resumeStep, "replace");
        if (disposition === "POST_PAYMENT") return;
        if (value.purchaseType === "TOPUP") {
          if (value.status === "PAYMENT_PENDING" && value.payment) {
            setPayment({
              reference: value.payment.reference,
              redirectUrl: "",
              expiresAt: "",
            });
            void verifyPayment(value);
          }
          return;
        }
        if (value.status === "PAYMENT_PENDING" && value.payment) {
          setPayment({
            reference: value.payment.reference,
            redirectUrl: "",
            expiresAt: "",
          });
          void verifyPayment(value);
        } else if (value.status === "PAYMENT_FAILED") {
          setPayment(null);
        }
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Order could not be resumed",
        ),
      )
      .finally(() => {
        setBusy(false);
        setResumingOrder(false);
      });
  }, [orderId, isLoaded, guestToken, recoveryReady]);
  const VERIFY_DELAYS = [
    0, 2_000, 4_000, 7_000, 10_000, 15_000, 20_000, 30_000, 45_000,
  ];
  const VERIFY_BUDGET_MS = 120_000;
  const TERMINAL_STATUSES = [
    "PAYMENT_CONFIRMED",
    "PAYMENT_REVIEW_REQUIRED",
    "REVIEW_PENDING",
    "APPROVED",
    "PROVISIONING",
    "QR_READY",
    "ACTIVATION_ATTENTION",
    "COMPLETED",
    "PAYMENT_FAILED",
    "PROVISIONING_FAILED",
    "CANCELLED",
    "REFUND_PENDING",
    "REFUNDED",
  ];
  const FULFILLMENT_IN_PROGRESS_STATUSES = [
    "PAYMENT_CONFIRMED",
    "REVIEW_PENDING",
    "APPROVED",
    "PROVISIONING",
  ];
  const stripReturnParams = () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (
      !["reference", "pidx", "simulated"].some((key) =>
        url.searchParams.has(key),
      )
    )
      return;
    for (const key of [
      "reference",
      "pidx",
      "simulated",
      "status",
      "purchase_order_id",
      "transaction_id",
      "amount",
    ])
      url.searchParams.delete(key);
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
      const wait =
        VERIFY_DELAYS[Math.min(attempt, VERIFY_DELAYS.length - 1)] ?? 0;
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (verifyRunToken.current !== token) return;
      }
      attempt += 1;
      try {
        // Retry the verification lookup itself (not just the order poll):
        // Khalti can report pending/initiated for a few seconds after the
        // wallet redirect, so a single attempt is not enough.
        const updated = await api<Order>(
          `/customer/orders/${current.id}/payment/verify`,
          {
            method: "POST",
            body: JSON.stringify({ reference: current.payment?.reference }),
          },
        );
        setOrder(updated);
        current = updated;
        if (TERMINAL_STATUSES.includes(updated.status)) {
          setVerifying(false);
          return;
        }
      } catch (cause) {
        const code = (cause as { code?: string })?.code;
        if (
          code === "PAYMENT_EXPIRED" ||
          code === "PAYMENT_REFERENCE_MISMATCH" ||
          code === "PAYMENT_NOT_CONFIRMED"
        ) {
          const refreshed = await api<Order>(
            `/customer/orders/${current.id}`,
          ).catch(() => current);
          setOrder(refreshed);
          current = refreshed;
          setVerifying(false);
          return;
        }
        // Transient network/provider errors retry; refresh the order so the
        // UI stays current without treating an unknown error as "pending".
        const refreshed = await api<Order>(
          `/customer/orders/${current.id}`,
        ).catch(() => current);
        setOrder(refreshed);
        current = refreshed;
        if (TERMINAL_STATUSES.includes(refreshed.status)) {
          setVerifying(false);
          return;
        }
      }
    }
    setOrder(
      await api<Order>(`/customer/orders/${current.id}`).catch(() => current),
    );
    setError(
      "Your payment is still being confirmed. Return to this tracking page shortly.",
    );
    setVerifying(false);
  };
  const update = (key: keyof Traveler, value: string) => {
    setTraveler((v) => ({ ...v, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
  };
  const verifyPassport = async (): Promise<Order | null> => {
    if (!order || verifyingPassport) return order;
    if (Date.now() < passportRetryNoBefore.current) {
      setDocumentError(
        "Please wait a minute before checking again. Your documents are saved.",
      );
      return null;
    }
    setDocumentMessage("Checking your passport…");
    setVerifyingPassport(true);
    setError("");
    try {
      const updated = await api<Order>(
        `/customer/orders/${order.id}/verify-passport`,
        { method: "POST", body: "{}" },
      );
      setOrder(updated);
      return updated;
    } catch (e) {
      if ((e as { code?: string }).code === "RATE_LIMITED")
        passportRetryNoBefore.current = Date.now() + 60_000;
      setDocumentError(
        "Could not connect to verification. Your saved files are safe. Try checking again.",
      );
      return null;
    } finally {
      setVerifyingPassport(false);
      setDocumentMessage("");
    }
  };
  const [documentMessage, setDocumentMessage] = useState("");
  const [documentError, setDocumentError] = useState("");
  const uploadDocument = useRef(createDocumentUploader());
  const passportGatePassed = (target: Order | null) =>
    !target ||
    isTopUp ||
    ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
      target.documentReviewStatus ?? "",
    );
  useEffect(() => {
    if (![3, 4].includes(step) || isTopUp || busy) return;
    if (!order || order.passportVerification) return;
    if (
      !["PASSPORT", "TICKET"].every((type) =>
        hasSavedDocument(order.documents, type),
      )
    )
      return;
    void verifyPassport();
  }, [step, order?.id, isTopUp]);
  useDocumentRefresh(
    [3, 4].includes(step) &&
      !isTopUp &&
      !busy &&
      !verifyingPassport &&
      ["OCR_PENDING", "OCR_BACKGROUND", "MANUAL_REVIEW"].includes(
        order?.documentReviewStatus ?? "",
      ),
    async (isCurrent) => {
      if (!order) return;
      const refreshed = await api<Order>(`/customer/orders/${order.id}`);
      if (!isCurrent()) return;
      setOrder(refreshed);
      setDocumentError("");
    },
    () =>
      setDocumentError(
        "Connection interrupted. Your files are saved. We’ll keep trying to refresh verification.",
      ),
    order?.documentReviewStatus === "MANUAL_REVIEW",
  );
  useEffect(() => {
    if (
      order?.status === "DRAFT" &&
      step === 4 &&
      !isTopUp &&
      (!passportGatePassed(order) || Object.values(files).some(Boolean))
    )
      setStep(3);
  }, [step, order, isTopUp, files]);
  useEffect(() => {
    if (
      verifying ||
      !order ||
      !FULFILLMENT_IN_PROGRESS_STATUSES.includes(order.status)
    )
      return;
    // Payment confirmation hands work to a background provisioning queue. Keep
    // the checkout current until that workflow reaches a customer-visible
    // terminal state (for example QR_READY) instead of leaving a stale spinner.
    const timer = setTimeout(() => {
      void api<Order>(`/customer/orders/${order.id}`)
        .then(setOrder)
        .catch(() => undefined);
    }, 3_000);
    return () => clearTimeout(timer);
  }, [order, verifying]);
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
  const requestPayment = async (target: Order) => {
    const value = await api<Payment>(`/customer/orders/${target.id}/payment`, {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    setPayment(value);
    let isExternal = true;
    try {
      isExternal = new URL(value.redirectUrl).origin !== window.location.origin;
    } catch {
      isExternal = true;
    }
    if (value.redirectUrl && isExternal)
      window.location.assign(value.redirectUrl);
  };
  const createOrder = (asGuest: boolean) =>
    run(async () => {
      if (order) {
        if (isTopUp) {
          setStep(4);
          return;
        }
        setStep(order.traveler ? 3 : 2);
        return;
      }
      if (!isLoaded)
        throw new Error(
          "Finishing secure sign-in. Please try again in a moment.",
        );
      if (!planId) throw new Error("Choose a plan before checkout");
      if (!compatible && !isTopUpIntent)
        throw new Error("Confirm device compatibility");
      if (!legalAccepted)
        throw new Error("Accept the Terms and Privacy Policy to continue");
      if (isTopUp) {
        rechargeMode.current = true;
        const storageKey = "vc_recharge_checkout_attempt";
        const fingerprint = JSON.stringify({
          planId,
          targetEsimId: targetEsimId ?? null,
          mobile: mobile ?? null,
        });
        let attempt: { key: string; fingerprint: string } | null = null;
        try {
          attempt = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        } catch {
          /* invalid saved attempt */
        }
        if (!attempt || attempt.fingerprint !== fingerprint) {
          attempt = { key: crypto.randomUUID(), fingerprint };
          localStorage.setItem(storageKey, JSON.stringify(attempt));
        }
        const created = await api<{
          order: Order;
          token: string;
          recovery: { token: string; expiresAt: string };
        }>("/customer/orders", {
          method: "POST",
          body: JSON.stringify({
            planId,
            termsAccepted: true,
            privacyAccepted: true,
            checkoutAttemptKey: attempt.key,
            ...(lookupToken ? { lookupToken } : { targetEsimId }),
          }),
        });
        setOrder(created.order);
        guestRef.current = isSignedIn !== true;
        setGuest(isSignedIn !== true);
        storeGuestToken(created.token, created.order.id);
        storeRecovery(
          created.order.id,
          created.recovery.token,
          created.recovery.expiresAt,
        );
        window.history.replaceState(
          window.history.state,
          "",
          `/esim/checkout?order=${encodeURIComponent(created.order.id)}&recharge=1`,
        );
        setStep(4);
        await requestPayment(created.order);
        return;
      }
      guestRef.current = asGuest;
      setGuest(asGuest);
      if (asGuest) {
        const created = await api<{
          order: Order;
          token: string;
          recovery: { token: string; expiresAt: string };
        }>("/customer/orders", {
          method: "POST",
          body: JSON.stringify({
            planId,
            compatibilityAccepted: true,
            termsAccepted: true,
            privacyAccepted: true,
            mobile: mobile || traveler.mobile || undefined,
            lookupToken: lookupToken || undefined,
          }),
        });
        setOrder(created.order);
        storeGuestToken(created.token, created.order.id);
        storeRecovery(
          created.order.id,
          created.recovery.token,
          created.recovery.expiresAt,
        );
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("order", created.order.id);
          window.history.replaceState(window.history.state, "", url.toString());
        } catch {
          /* history unavailable; the recovery card remains copyable */
        }
        if (created.order.purchaseType === "TOPUP") {
          setStep(4);
          await requestPayment(created.order);
        } else {
          setStep(2);
        }
        return;
      }
      const payload: { order: Order; token: string } | Order = await api<
        { order: Order; token: string } | Order
      >("/customer/orders", {
        method: "POST",
        body: JSON.stringify({
          planId,
          compatibilityAccepted: true,
          termsAccepted: true,
          privacyAccepted: true,
          mobile: mobile || traveler.mobile || undefined,
          lookupToken: lookupToken || undefined,
          ...(targetEsimId ? { targetEsimId } : {}),
        }),
      });
      const isGuestPayload =
        typeof payload === "object" &&
        payload !== null &&
        "order" in payload &&
        "token" in payload;
      const finalOrder: Order = isGuestPayload
        ? (payload as { order: Order }).order
        : (payload as Order);
      setOrder(finalOrder);
      if (finalOrder.traveler)
        setTraveler({ ...initial, ...finalOrder.traveler });
      if (isGuestPayload) {
        storeGuestToken((payload as { token: string }).token, finalOrder.id);
      }
      if (finalOrder.purchaseType === "TOPUP") {
        setStep(4);
        await requestPayment(finalOrder);
      } else {
        setStep(2);
      }
    });
  const begin = () => {
    if (order) {
      void createOrder(guestRef.current);
      return;
    }
    if (!compatible && !isTopUpIntent) {
      setCompatibilityError(
        "Confirm that your device is eSIM-compatible before continuing.",
      );
      return;
    }
    if (!legalAccepted) {
      setCompatibilityError(
        "Accept the Terms and Privacy Policy before continuing.",
      );
      return;
    }
    if (!isLoaded) {
      setError("Finishing secure sign-in. Please try again in a moment.");
      return;
    }
    if (isTopUpIntent || isSignedIn === true) {
      void createOrder(false);
      return;
    }
    setShowAccountChoice(true);
  };
  useEffect(() => {
    if (!pendingSignIn || isSignedIn !== true) return;
    setPendingSignIn(false);
    setShowAccountChoice(false);
    void createOrder(false);
  }, [pendingSignIn, isSignedIn]);

  const claimGuestOrder = () =>
    run(async () => {
      if (!order || isTopUp || !currentToken()) return;
      const mutation = mutationKey(`claim-guest:${order.id}`);
      const response = await authFetch(
        `${API}/customer/orders/${order.id}/claim-guest`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": mutation.key,
            "x-guest-order-token": currentToken(),
          },
          body: "{}",
        },
      );
      releaseMutationKey(mutation.storageKey);
      const payload = (await response.json()) as Envelope<Order>;
      if (!response.ok || !payload.data)
        throw new Error(
          apiErrorMessage(
            payload.error?.code ?? "UNEXPECTED",
            "We could not save this order to your account",
          ),
        );
      try {
        sessionStorage.removeItem(tokenKey(order.id));
        sessionStorage.removeItem(recoveryKey(order.id));
      } catch {
        /* storage unavailable */
      }
      guestTokenRef.current = "";
      setGuestToken("");
      guestRef.current = false;
      setGuest(false);
      setRecovery(null);
      setOrder(payload.data);
    });
  useEffect(() => {
    if (!claimIntent || isSignedIn !== true) return;
    setClaimIntent(false);
    void claimGuestOrder();
  }, [claimIntent, isSignedIn]);
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
      const firstError = Object.keys(nextErrors)[0];
      if (firstError) {
        document.querySelector<HTMLElement>(`[name="${firstError}"]`)?.focus();
        throw new Error("Check the highlighted traveller details");
      }
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
      const updated = await api<Order>(
        `/customer/orders/${order.id}/traveler`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      );
      setOrder(updated);
      advance(3);
    });
  const saveDocuments = () =>
    run(async () => {
      setDocumentError("");
      try {
        if (
          !order ||
          ["PASSPORT", "TICKET"].some(
            (type) =>
              !files[type.toLowerCase() as "passport" | "ticket"] &&
              !hasUploadedDocument(order.documents, type),
          )
        )
          throw new Error("Passport and travel ticket are required");
        await submitCheckoutDocumentsSequentially(
          files,
          async ({ key, file, type }) => {
            const saved = await uploadDocument.current({
              type,
              file,
              basePath: `/customer/orders/${order.id}/documents`,
              request: api,
              progress: setDocumentMessage,
            });
            setOrder((current) =>
              current
                ? {
                    ...current,
                    ...(type === "PASSPORT"
                      ? {
                          documentReviewStatus: "NOT_STARTED" as const,
                          passportVerification: { status: "NOT_STARTED" },
                        }
                      : {}),
                    documents: [
                      ...(current.documents ?? []).filter(
                        (doc) => doc.type !== type,
                      ),
                      saved,
                    ],
                  }
                : current,
            );
            setFiles((current) => ({
              ...current,
              [key]: current[key] === file ? undefined : current[key],
            }));
          },
        );
        const refreshed = await api<Order>(`/customer/orders/${order.id}`);
        setOrder(refreshed);
        setEditingVerifiedDocuments(false);
        if (
          !refreshed.documentReviewStatus ||
          refreshed.documentReviewStatus === "NOT_STARTED"
        )
          await verifyPassport();
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
  const initiate = (orderArg?: Order) =>
    run(async () => {
      let target = orderArg ?? order;
      if (target) {
        let verification = target.passportVerification;
        if (
          !isTopUp &&
          !passportGatePassed(target) &&
          (verification?.status === "FAILED" ||
            verification?.status === "PARTIAL")
        ) {
          throw new Error(
            "We couldn't verify your passport against your traveller details. Review your details and re-check your passport before paying.",
          );
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
        await requestPayment(target);
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
          await api<Order>(endpoint, {
            method: "POST",
            body: JSON.stringify({ reference: payment.reference }),
          }),
        );
        return;
      }
      void verifyPayment(order);
    });
  useEffect(() => {
    if (!payment?.websocketUrl || !order) return;
    let socket: WebSocket | undefined;
    try {
      socket = new WebSocket(payment.websocketUrl);
      socket.onmessage = () => complete(); // Socket is only a prompt; API verification remains authoritative.
    } catch {
      /* Manual status verification remains available. */
    }
    return () => socket?.close();
  }, [payment?.websocketUrl, order?.id]);
  useEffect(() => {
    if (!payment || !order || SIMULATOR) return;
    const interval = window.setInterval(() => {
      if (new Date(payment.expiresAt).getTime() > Date.now()) void complete();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [payment?.reference, payment?.expiresAt, order?.id]);

  const recoveryUrl =
    order && recovery && typeof window !== "undefined"
      ? `${window.location.origin}/esim/checkout?order=${encodeURIComponent(order.id)}${isTopUp ? "&recharge=1" : ""}#resume=${encodeURIComponent(recovery.token)}`
      : "";
  const copyRecoveryLink = async () => {
    if (!recoveryUrl) return;
    try {
      await navigator.clipboard.writeText(recoveryUrl);
      setCopiedRecovery(true);
      window.setTimeout(() => setCopiedRecovery(false), 2_500);
    } catch {
      setError(
        "Copy was blocked. Keep this tab open or use the emailed link after entering your details.",
      );
    }
  };

  const transitionRef = useCheckoutTransition(
    `${step}:${showAccountChoice}`,
    !busy && !resumingOrder,
  );
  if ((!planId && !orderId) || planLoadFailed)
    return (
      <main className="checkout-page">
        <div className="checkout-recovery">
          <QrCode />
          <h1>We could not load this checkout</h1>
          <p>The plan link may be incomplete or no longer available.</p>
          <div>
            <Link className="button" href="/destinations">
              Choose a plan
            </Link>
            {isSignedIn === true && (
              <Link className="button secondary" href="/account/orders">
                Order history
              </Link>
            )}
          </div>
        </div>
      </main>
    );
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
              ? "Add a package to the authorized eSIM. Review your plan, pay, and track the recharge here."
              : "Complete verification once. We’ll keep your order safe while our team reviews it."}
          </p>
        </div>
        <div className="checkout-progress">
          <span style={{ width: `${(isTopUp ? 1 : step * 0.25) * 100}%` }} />
        </div>
        <div className="checkout-layout">
          <section className="checkout-card" ref={transitionRef}>
            <div className="step-tabs">
              {(isTopUp
                ? ["Payment"]
                : ["Compatibility", "Traveller", "Documents", "Payment"]
              ).map((label, index) => (
                <div
                  key={label}
                  className={
                    isTopUp || step === index + 1
                      ? "active"
                      : step > index + 1
                        ? "done"
                        : ""
                  }
                >
                  <i>
                    {!isTopUp && step > index + 1 ? (
                      <Check size={13} />
                    ) : (
                      index + 1
                    )}
                  </i>
                  {!isTopUp && step > index + 1 ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => jumpTo(index + 1)}
                      title={`Go back to ${label}`}
                    >
                      <span>{label}</span>
                    </button>
                  ) : (
                    <span>{label}</span>
                  )}
                </div>
              ))}
            </div>
            {error && <ErrorModal error={error} onClose={() => setError("")} />}
            {showAccountChoice && (
              <div
                className="form-section account-choice"
                aria-labelledby="checkout-account-title"
              >
                <span className="form-icon">
                  <UserRound />
                </span>
                <h2 id="checkout-account-title">
                  How would you like to continue?
                </h2>
                <p>
                  Sign in to keep this order in My eSIMs and check verification
                  status from any device.
                </p>
                <div className="account-choice-grid">
                  <div className="account-choice-primary">
                    <span className="choice-badge">Recommended</span>
                    <b>Continue with an account</b>
                    <small>
                      Order history, easier status checks, and secure access
                      across devices.
                    </small>
                    {!isTopUp &&
                      (isSignedIn === true ? (
                        <button
                          className="button wide"
                          disabled={busy}
                          onClick={() => {
                            setShowAccountChoice(false);
                            void createOrder(false);
                          }}
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
                      ))}
                  </div>
                  <div className="account-choice-guest">
                    <b>Continue as guest</b>
                    <small>
                      No account required. You’ll receive a private recovery
                      link to keep this order.
                    </small>
                    <button
                      className="button secondary wide"
                      disabled={busy}
                      onClick={() => {
                        setShowAccountChoice(false);
                        void createOrder(true);
                      }}
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
            )}
            {!showAccountChoice && isTopUp && order && recovery && (
              <div className="guest-recovery-card" role="note">
                <span className="guest-recovery-icon">
                  <Link2 />
                </span>
                <div>
                  <b>Keep your private order link</b>
                  <p>
                    Save this link before closing the tab. It restores order{" "}
                    {order.orderNumber} and its verification status for 24
                    hours. Anyone with the link can access this order.
                  </p>
                  <small>
                    A tracking link is queued for the original purchase email.
                    You can also copy it here.
                  </small>
                  <div className="guest-recovery-actions">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => void copyRecoveryLink()}
                    >
                      <Copy size={16} />{" "}
                      {copiedRecovery ? "Link copied" : "Copy private link"}
                    </button>
                  </div>
                  <span className="sr-only" aria-live="polite">
                    {copiedRecovery ? "Private recovery link copied" : ""}
                  </span>
                </div>
              </div>
            )}
            {isTopUp && order && (
              <div className="guest-recovery-card" role="status">
                <div>
                  <b>{order.orderNumber}</b>
                  <p>
                    Payment: {order.payment?.status ?? "Not started"} ·
                    Recharge: {orderStatusLabel(order.status)}
                  </p>
                  {order.refundStatus && (
                    <p>
                      Refund:{" "}
                      {order.refundStatus.toLowerCase().replaceAll("_", " ")}
                    </p>
                  )}
                  {["COMPLETED", "QR_READY", "CANCELLED", "REFUNDED"].includes(
                    order.status,
                  ) && (
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        localStorage.removeItem("vc_recharge_checkout_attempt");
                        window.location.assign("/");
                      }}
                    >
                      Start another purchase
                    </button>
                  )}
                </div>
              </div>
            )}
            {resumingOrder && (
              <div className="form-section" role="status" aria-live="polite">
                <span className="form-icon">
                  <LoaderCircle className="spin" />
                </span>
                <h2>Restoring your order</h2>
                <p>
                  We are securely loading your saved checkout and will return
                  you to the correct step.
                </p>
              </div>
            )}
            {!showAccountChoice && !resumingOrder && step === 1 && (
              <div className="form-section">
                <span className="form-icon">
                  <ShieldCheck />
                </span>
                <h2>Confirm your device</h2>
                <p>
                  Your phone must support eSIM and be carrier-unlocked. Coverage
                  starts after first connection at your destination.
                </p>
                <CompatibilityConfirmation
                  checked={compatible}
                  invalid={Boolean(compatibilityError) && !compatible}
                  errorId={
                    compatibilityError ? "compatibility-error" : undefined
                  }
                  onChange={(checked) => {
                    setCompatible(checked);
                    if (checked) setCompatibilityError("");
                  }}
                />
                <PurchaseConsent
                  checked={legalAccepted}
                  invalid={Boolean(compatibilityError) && !legalAccepted}
                  errorId={
                    compatibilityError ? "compatibility-error" : undefined
                  }
                  onChange={(checked) => {
                    setLegalAccepted(checked);
                    if (checked) setCompatibilityError("");
                  }}
                />
                {compatibilityError ? (
                  <p
                    id="compatibility-error"
                    className="field-error"
                    role="alert"
                  >
                    {compatibilityError}
                  </p>
                ) : null}
                <Action
                  busy={busy}
                  disabled={!compatible || !legalAccepted}
                  onClick={begin}
                >
                  Continue
                </Action>
              </div>
            )}
            {!showAccountChoice && !resumingOrder && step === 2 && (
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
                      name="firstName"
                      autoComplete="given-name"
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
                      autoComplete="family-name"
                      value={traveler.surname}
                      onChange={(e) => update("surname", e.target.value)}
                    />
                  </Field>
                  <Field label="Date of birth" error={fieldErrors.dateOfBirth}>
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
                        update("passportNumber", e.target.value.toUpperCase())
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
                      onChange={(value) => update("passportExpiryDate", value)}
                    />
                  </Field>
                  <Field label="Nationality" error={fieldErrors.nationality}>
                    <input
                      name="nationality"
                      placeholder="NP"
                      list="country-codes"
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
                      autoComplete="address-level2"
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
                      list="country-codes"
                      autoComplete="country"
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
                      autoComplete="email"
                      type="email"
                      value={traveler.email}
                      onChange={(e) => update("email", e.target.value)}
                    />
                  </Field>
                  <Field label="Mobile / WhatsApp" error={fieldErrors.mobile}>
                    <input
                      name="mobile"
                      inputMode="tel"
                      autoComplete="tel"
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
                <datalist id="country-codes">
                  <option value="NP">Nepal</option>
                  <option value="IN">India</option>
                  <option value="US">United States</option>
                  <option value="GB">United Kingdom</option>
                  <option value="AU">Australia</option>
                  <option value="CA">Canada</option>
                  <option value="AE">United Arab Emirates</option>
                  <option value="JP">Japan</option>
                  <option value="KR">South Korea</option>
                </datalist>
                <Nav back={() => goBack()} busy={busy} next={saveTraveler} />
                {guest && order && recovery ? (
                  <details className="draft-recovery-option">
                    <summary>Need to finish this order later?</summary>
                    <div>
                      <p>
                        Copy a private draft link before closing this tab. It
                        expires in 24 hours and anyone with it can continue this
                        order. After you save these details, recovery access is
                        sent to the email above.
                      </p>
                      <div className="guest-recovery-actions">
                        <button
                          className="button secondary"
                          type="button"
                          onClick={() => void copyRecoveryLink()}
                        >
                          <Copy size={16} />
                          {copiedRecovery ? "Link copied" : "Copy draft link"}
                        </button>
                        {isSignedIn === true ? (
                          <button
                            className="button secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => void claimGuestOrder()}
                          >
                            Save to My eSIMs
                          </button>
                        ) : (
                          <SignInButton mode="modal">
                            <button
                              className="button secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => setClaimIntent(true)}
                            >
                              Sign in instead
                            </button>
                          </SignInButton>
                        )}
                      </div>
                      <span className="sr-only" aria-live="polite">
                        {copiedRecovery ? "Private draft link copied" : ""}
                      </span>
                    </div>
                  </details>
                ) : null}
              </div>
            )}
            {!showAccountChoice && !resumingOrder && step === 3 && (
              <div className="form-section">
                <span className="form-icon">
                  <FileCheck2 />
                </span>
                <h2>Travel documents</h2>
                <DocumentProgress
                  status={
                    Object.values(files).some(Boolean) &&
                    order?.documentReviewStatus !== "REUPLOAD_REQUIRED"
                      ? "NOT_STARTED"
                      : order?.documentReviewStatus
                  }
                  busy={busy || verifyingPassport}
                  message={documentError || documentMessage}
                />
                {passportGatePassed(order) && !editingVerifiedDocuments ? (
                  <>
                    <VerifiedDocumentsSummary
                      documents={order?.documents}
                      reviewStatus={order?.documentReviewStatus}
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
                        onClick={() => advance(4)}
                      >
                        Continue to payment
                      </button>
                    </div>
                    <button
                      type="button"
                      className="document-tertiary-action"
                      onClick={() => jumpTo(2)}
                    >
                      Edit traveller details
                    </button>
                  </>
                ) : (
                  <>
                    {order?.documentReviewStatus !== "REUPLOAD_REQUIRED" && (
                      <SavedDocuments documents={order?.documents} />
                    )}
                    {![
                      "OCR_PENDING",
                      "OCR_BACKGROUND",
                      "MANUAL_REVIEW",
                    ].includes(order?.documentReviewStatus ?? "") && (
                      <>
                        {editingVerifiedDocuments && (
                          <p className="document-change-warning">
                            Replacing your passport starts verification again.
                            Changing the optional visa does not affect your
                            passport result.
                          </p>
                        )}
                        {order?.documentReviewStatus === "REUPLOAD_REQUIRED" ? (
                          <DocumentRecoveryFields
                            documents={order.documents}
                            types={["PASSPORT", "TICKET", "VISA"]}
                            files={{
                              PASSPORT: files.passport,
                              TICKET: files.ticket,
                              VISA: files.visa,
                            }}
                            onChange={(type, file) =>
                              setFiles((current) => ({
                                ...current,
                                [type.toLowerCase()]: file,
                              }))
                            }
                            disabled={busy}
                          />
                        ) : (
                          <fieldset
                            className="upload-list document-fields"
                            disabled={busy}
                          >
                            <FileField
                              label="Passport"
                              file={files.passport}
                              savedName={
                                order?.documents?.find(
                                  (doc) =>
                                    doc.type === "PASSPORT" &&
                                    doc.uploadVerified,
                                )?.fileName
                              }
                              onChange={(v) =>
                                setFiles((f) => ({ ...f, passport: v }))
                              }
                              capture
                            />
                            <FileField
                              label="Travel ticket"
                              file={files.ticket}
                              savedName={
                                order?.documents?.find(
                                  (doc) =>
                                    doc.type === "TICKET" && doc.uploadVerified,
                                )?.fileName
                              }
                              onChange={(v) =>
                                setFiles((f) => ({ ...f, ticket: v }))
                              }
                              capture
                            />
                            <FileField
                              label="Visa (optional)"
                              file={files.visa}
                              savedName={
                                order?.documents?.find(
                                  (doc) =>
                                    doc.type === "VISA" && doc.uploadVerified,
                                )?.fileName
                              }
                              onChange={(v) =>
                                setFiles((f) => ({ ...f, visa: v }))
                              }
                              capture
                            />
                          </fieldset>
                        )}
                      </>
                    )}
                    <div className="form-actions">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || verifyingPassport}
                        onClick={() => {
                          if (editingVerifiedDocuments) {
                            setFiles({
                              passport: undefined,
                              ticket: undefined,
                              visa: undefined,
                            });
                            setEditingVerifiedDocuments(false);
                          } else jumpTo(2);
                        }}
                      >
                        {editingVerifiedDocuments
                          ? "Cancel changes"
                          : order?.documentReviewStatus === "REUPLOAD_REQUIRED"
                            ? "Check traveller details"
                            : "Edit traveller details"}
                      </button>
                      <button
                        type="button"
                        className="button primary"
                        disabled={
                          busy ||
                          verifyingPassport ||
                          (editingVerifiedDocuments &&
                            !Object.values(files).some(Boolean)) ||
                          (!Object.values(files).some(Boolean) &&
                            [
                              "OCR_PENDING",
                              "OCR_BACKGROUND",
                              "MANUAL_REVIEW",
                            ].includes(order?.documentReviewStatus ?? "")) ||
                          (!Object.values(files).some(Boolean) &&
                            order?.documentReviewStatus === "REUPLOAD_REQUIRED")
                        }
                        onClick={() => void saveDocuments()}
                      >
                        {busy
                          ? "Saving documents…"
                          : editingVerifiedDocuments
                            ? "Save changes"
                            : !Object.values(files).some(Boolean) &&
                                order?.documentReviewStatus === "MANUAL_REVIEW"
                              ? "Awaiting approval"
                              : !Object.values(files).some(Boolean) &&
                                  ["OCR_PENDING", "OCR_BACKGROUND"].includes(
                                    order?.documentReviewStatus ?? "",
                                  )
                                ? "Verification in progress"
                                : order?.documentReviewStatus ===
                                    "REUPLOAD_REQUIRED"
                                  ? files.passport
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
            {!showAccountChoice && !resumingOrder && step === 4 && (
              <div className="form-section">
                <h2>
                  {order &&
                  [
                    "PAYMENT_CONFIRMED",
                    "REVIEW_PENDING",
                    "APPROVED",
                    "PROVISIONING",
                    "QR_READY",
                    "ACTIVATION_ATTENTION",
                    "COMPLETED",
                  ].includes(order.status)
                    ? "Payment verified"
                    : order &&
                        [
                          "PAYMENT_FAILED",
                          "PROVISIONING_FAILED",
                          "CANCELLED",
                        ].includes(order.status)
                      ? order.purchaseType === "TOPUP" &&
                        order.status === "PROVISIONING_FAILED"
                        ? "Recharge needs attention"
                        : "Payment issue"
                      : "Choose payment method"}
                </h2>
                {!isTopUp ? (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={goBack}
                    disabled={busy || verifying}
                  >
                    Back to documents
                  </button>
                ) : null}
                {isTopUp &&
                order &&
                ["REFUNDED", "REFUND_PENDING", "CANCELLED"].includes(
                  order.status,
                ) ? (
                  <div className="success-panel">
                    <b>{orderStatusLabel(order.status)}</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      {order.status === "REFUND_PENDING"
                        ? "Your refund is being processed. Return to this tracking link for updates."
                        : "This recharge is closed. No further payment is needed for this order."}
                    </p>
                  </div>
                ) : order &&
                  ["QR_READY", "ACTIVATION_ATTENTION"].includes(
                    order.status,
                  ) ? (
                  <div className="success-panel">
                    {isTopUp ? (
                      <CheckCircle2 size={42} />
                    ) : (
                      <QrCode size={42} />
                    )}
                    <b>
                      {isTopUp
                        ? "Package added to your existing eSIM"
                        : "Your activation QR has been sent"}
                    </b>
                    <span>{order.orderNumber}</span>
                    <p>
                      {isTopUp
                        ? "No new QR code or installation is required. The package will become active on your existing eSIM when the provider confirms first use."
                        : "Install your eSIM using the QR image emailed to you, then connect to the network once to activate it. Your order will complete automatically."}
                    </p>
                    {isSignedIn === true && !isTopUp && (
                      <>
                        <Link className="button" href="/account/esims">
                          View my eSIMs
                        </Link>
                        <Link
                          className="button"
                          href={
                            isTopUp
                              ? `/esim/checkout?order=${order.id}&recharge=1`
                              : `/account/orders/${order.id}`
                          }
                        >
                          Didn&apos;t get the QR? Recover it
                        </Link>
                        <button
                          className="button secondary"
                          onClick={resendQrEmail}
                          disabled={uxResending}
                        >
                          {uxResending ? "Sending…" : "Re-send email"}
                        </button>
                      </>
                    )}
                  </div>
                ) : order?.status === "COMPLETED" ? (
                  <div className="success-panel">
                    <CheckCircle2 size={42} />
                    <b>
                      {isTopUp ? "Your top-up is active" : "Your eSIM is ready"}
                    </b>
                    <span>{order.orderNumber}</span>
                    <p>
                      {isTopUp
                        ? "The package is active on your existing eSIM. No new QR code or installation is required."
                        : "Your activation QR was emailed to you as an image. Open it on another screen and scan it from your phone's eSIM settings."}
                    </p>
                    {isSignedIn === true && !isTopUp && (
                      <>
                        <Link className="button" href="/account/esims">
                          View my eSIMs
                        </Link>
                        <Link
                          className="button"
                          href={
                            isTopUp
                              ? `/esim/checkout?order=${order.id}&recharge=1`
                              : `/account/orders/${order.id}`
                          }
                        >
                          Didn&apos;t get the QR? Recover it
                        </Link>
                        <button
                          className="button secondary"
                          onClick={resendQrEmail}
                          disabled={uxResending}
                        >
                          {uxResending ? "Sending…" : "Re-send email"}
                        </button>
                      </>
                    )}
                  </div>
                ) : order?.status === "PAYMENT_REVIEW_REQUIRED" ? (
                  <div className="info-panel">
                    <AlertTriangle size={42} />
                    <b>Your payment needs confirmation</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      We could not get a definitive response from the payment
                      provider. Your order has not been cancelled or charged
                      again. Our operations team can safely recheck it.
                    </p>
                    {isSignedIn === true && (
                      <Link
                        className="button secondary"
                        href={
                          isTopUp
                            ? `/esim/checkout?order=${order.id}&recharge=1`
                            : `/account/orders/${order.id}`
                        }
                      >
                        Check status
                      </Link>
                    )}
                  </div>
                ) : order && order.status === "PROVISIONING_FAILED" ? (
                  <div className="error-panel">
                    <AlertTriangle size={42} />
                    <b>
                      {isTopUp
                        ? "Your recharge needs attention"
                        : "Your eSIM activation needs attention"}
                    </b>
                    <span>{order.orderNumber}</span>
                    <p>
                      {order.provisioningFailure?.message ??
                        (isTopUp
                          ? "Your payment was received, but we could not complete the recharge with the network provider. Our team is reviewing it and will contact you."
                          : "Your payment was received, but we could not finish the eSIM activation. Our team is reviewing it and will contact you.")}
                    </p>
                    <Link className="button secondary" href="/">
                      Return home
                    </Link>
                    {isSignedIn === true && (
                      <Link
                        className="button"
                        href={
                          isTopUp
                            ? `/esim/checkout?order=${order.id}&recharge=1`
                            : `/account/orders/${order.id}`
                        }
                      >
                        Check status
                      </Link>
                    )}
                  </div>
                ) : order &&
                  [
                    "PAYMENT_CONFIRMED",
                    "REVIEW_PENDING",
                    "APPROVED",
                    "PROVISIONING",
                  ].includes(order.status) ? (
                  <div className="success-panel">
                    <LoaderCircle className="spin" size={42} />
                    <b>Payment verified. Activating your eSIM</b>
                    <span>{order.orderNumber}</span>
                    <p>
                      {isTopUp
                        ? "Payment received. Your recharge is processing. You can close this page and return using your tracking link."
                        : "Your eSIM is being activated automatically. Your QR image will be emailed to you shortly."}
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
                    <b>
                      {paymentStatusHeading(
                        order?.payment?.provider ?? provider,
                      )}
                    </b>
                    <span>{order?.orderNumber}</span>
                    <p>
                      We are checking with your payment provider. Your order
                      will only be marked as paid after the gateway confirms the
                      transaction.
                    </p>
                  </div>
                ) : (
                  <>
                    {order && !isTopUp && (
                      <PassportCheck
                        result={order.passportVerification}
                        reviewStatus={order.documentReviewStatus}
                        {...(order.payment?.status
                          ? { paymentStatus: order.payment.status }
                          : {})}
                        busy={verifyingPassport}
                        onRecheck={() => void verifyPassport()}
                        onEdit={() => jumpTo(2)}
                      />
                    )}
                    {order &&
                      [
                        "PAYMENT_FAILED",
                        "PROVISIONING_FAILED",
                        "CANCELLED",
                      ].includes(order.status) && (
                        <p>
                          Your earlier payment could not be confirmed. You can
                          try again below.
                        </p>
                      )}
                    <p>
                      Review the total before continuing. Your payment and
                      recharge status will be shown here.
                    </p>
                    {isTopUp && rechargeTargetLabel && (
                      <p className="form-note">
                        Adding data to {rechargeTargetLabel}. Keep using your
                        existing eSIM.
                      </p>
                    )}
                    <div className="gateway-grid">
                      <button
                        className={
                          provider === PaymentProvider.KHALTI ? "selected" : ""
                        }
                        onClick={() => setProvider(PaymentProvider.KHALTI)}
                      >
                        <b>Khalti</b>
                        <small>Digital wallet</small>
                      </button>
                      {availableProviders.includes(PaymentProvider.FONEPAY) ? (
                        <button
                          className={`fonepay-provider ${provider === PaymentProvider.FONEPAY ? "selected" : ""}`}
                          onClick={() => setProvider(PaymentProvider.FONEPAY)}
                        >
                          <img
                            src="/brand/fonepay-logo.png"
                            alt="Checkout by Fonepay"
                          />
                          <small>Mobile banking &amp; QR</small>
                        </button>
                      ) : null}
                    </div>
                    {isTopUp && !order ? (
                      <>
                        <PurchaseConsent
                          checked={legalAccepted}
                          compact
                          invalid={Boolean(compatibilityError)}
                          errorId={
                            compatibilityError
                              ? "payment-consent-error"
                              : undefined
                          }
                          onChange={(checked) => {
                            setLegalAccepted(checked);
                            if (checked) setCompatibilityError("");
                          }}
                        />
                        {compatibilityError ? (
                          <p
                            id="payment-consent-error"
                            className="field-error"
                            role="alert"
                          >
                            {compatibilityError}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    {payment ? (
                      SIMULATOR ? (
                        <div className="simulator-box">
                          <span>Local signed simulator</span>
                          <small>
                            Reference: {payment.reference.slice(0, 14)}...
                          </small>
                          <Action
                            busy={busy}
                            disabled={paymentActionDisabled({
                              isTopUp,
                              verifyingPassport,
                              passportGatePassed: passportGatePassed(order),
                            })}
                            onClick={complete}
                          >
                            Simulate verified payment
                          </Action>
                        </div>
                      ) : payment.qrDataUrl ? (
                        <section
                          className="fonepay-checkout"
                          aria-labelledby="fonepay-checkout-title"
                        >
                          <img
                            className="fonepay-checkout-logo"
                            src="/brand/fonepay-logo.png"
                            alt="Checkout by Fonepay"
                          />
                          <div className="fonepay-qr-stage">
                            <h2 id="fonepay-checkout-title">Scan to pay</h2>
                            <p>
                              Scan this QR with a Fonepay-supported mobile
                              banking app.
                            </p>
                            <img
                              className="fonepay-qr"
                              src={payment.qrDataUrl}
                              alt="Fonepay payment QR code"
                            />
                          </div>
                          {payment.banks?.length ? (
                            <div className="fonepay-bank-section">
                              <div className="fonepay-bank-heading">
                                <b>Or pay with your banking app</b>
                                <small>
                                  Select your bank to continue securely.
                                </small>
                              </div>
                              <label className="fonepay-bank-search">
                                <span className="sr-only">
                                  Search banking apps
                                </span>
                                <input
                                  type="search"
                                  value={fonepayBankQuery}
                                  onChange={(event) =>
                                    setFonepayBankQuery(event.target.value)
                                  }
                                  placeholder="Search banking apps"
                                />
                              </label>
                              <div className="fonepay-bank-list">
                                {filterFonepayBanks(
                                  payment.banks,
                                  fonepayBankQuery,
                                ).map((bank) => (
                                  <button
                                    key={bank.bankCode}
                                    onClick={() => {
                                      if (!payment.qrPayload) return;
                                      const target = fonepayBankIntentUrl(
                                        bank.intentScheme,
                                        payment.qrPayload,
                                      );
                                      if (target)
                                        window.location.assign(target);
                                      else
                                        setError(
                                          "This banking app cannot be opened securely. Please choose another bank or scan the QR code.",
                                        );
                                    }}
                                  >
                                    <span className="fonepay-bank-identity">
                                      {bank.bankIcon ? (
                                        <img
                                          src={bank.bankIcon}
                                          alt={`${bank.bankName} logo`}
                                        />
                                      ) : (
                                        <span
                                          className="fonepay-bank-fallback"
                                          aria-hidden="true"
                                        >
                                          {bank.bankName.slice(0, 1)}
                                        </span>
                                      )}
                                      <b>{bank.bankName}</b>
                                    </span>
                                    <span className="fonepay-bank-open">
                                      Open app
                                    </span>
                                  </button>
                                ))}
                              </div>
                              {!filterFonepayBanks(
                                payment.banks,
                                fonepayBankQuery,
                              ).length ? (
                                <p className="fonepay-bank-empty">
                                  No matching banking app. Try another name or
                                  scan the QR code.
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                          <Action
                            busy={busy}
                            disabled={paymentActionDisabled({
                              isTopUp,
                              verifyingPassport,
                              passportGatePassed: passportGatePassed(order),
                            })}
                            onClick={complete}
                          >
                            Check payment status
                          </Action>
                          <small className="fonepay-security-note">
                            Your order is completed only after Fonepay confirms
                            the payment.
                          </small>
                        </section>
                      ) : (
                        <Action
                          busy={busy}
                          disabled={paymentActionDisabled({
                            isTopUp,
                            verifyingPassport,
                            passportGatePassed: passportGatePassed(order),
                          })}
                          onClick={complete}
                        >
                          Check payment status
                        </Action>
                      )
                    ) : isTopUp && !order ? (
                      <Action
                        busy={busy}
                        disabled={!legalAccepted}
                        onClick={begin}
                      >
                        Continue to payment
                      </Action>
                    ) : (
                      <Action
                        busy={busy}
                        disabled={paymentActionDisabled({
                          isTopUp,
                          verifyingPassport,
                          passportGatePassed: passportGatePassed(order),
                        })}
                        onClick={() => void initiate()}
                      >
                        Continue to{" "}
                        {provider === PaymentProvider.FONEPAY
                          ? "Fonepay"
                          : "Khalti"}
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
                {summaryPlan ? (
                  flagEmoji(summaryPlan.countryCode)
                ) : (
                  <Signal size={22} />
                )}
              </span>
              <span className="summary-plan-info">
                <span className="summary-label">Order summary</span>
                <b>{summaryPlan?.name ?? "Selected eSIM plan"}</b>
                <small>
                  {summaryPlan
                    ? `${summaryPlan.countryCode} · ${formatPlanDataText(summaryPlan.dataAllowance)}`
                    : "Loaded securely"}
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
                {summaryPlan
                  ? `${formatPlanDataText(summaryPlan.dataAllowance)} · ${summaryPlan.validityDays} days`
                  : "Loaded securely"}
              </b>
            </div>
            <div className="summary-total">
              <small>Total</small>
              <b>
                NPR{" "}
                {(
                  order?.totalAmountNpr ??
                  summaryPlan?.sellingPriceNpr ??
                  0
                ).toLocaleString()}
              </b>
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
  const paymentLabel =
    paymentStatus === "PENDING"
      ? "Payment awaiting confirmation"
      : paymentStatus === "FAILED"
        ? "No confirmed payment"
        : "Payment not started";
  if (reviewStatus === "OCR_BACKGROUND" || reviewStatus === "OCR_PENDING") {
    return (
      <div className="passport-check checking" role="status">
        <LoaderCircle className="spin" size={20} />
        <span>
          <b>Verifying your passport</b>
          <small>
            Payment unlocks as soon as the check completes. This usually takes
            only a few seconds.
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
            Our team needs to review your document before payment. We will
            notify you once it is approved — this page updates automatically.
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
        {onEdit && (
          <button className="button secondary" onClick={onEdit}>
            Replace document
          </button>
        )}
      </div>
    );
  }
  if (reviewStatus === "MANUALLY_APPROVED") {
    return (
      <div className="passport-check verified">
        <CheckCircle2 size={20} />
        <span>
          <b>Documents approved</b>
          <small>
            Our team reviewed and approved your documents. You can continue to
            payment.
          </small>
        </span>
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
          <b>Passport partially matched</b>
          <small>
            We could not confirm every detail on the document. Double-check the
            traveller details you entered, or replace it with a sharper photo of
            the information page, then re-check.
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
