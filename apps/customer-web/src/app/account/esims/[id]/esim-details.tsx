"use client";
import { useAuthenticatedFetch } from "../../../authenticated-api-provider";
import ErrorModal from "../../../../components/error-modal";
import { formatDataMb } from "../../../../lib/format-data";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  LoaderCircle,
  Mail,
  QrCode,
  Upload,
} from "lucide-react";
import "./recovery.css";
import { createDocumentUploader } from "../../../esim/checkout/document-upload";
import { useDocumentRefresh } from "../../../esim/checkout/use-document-refresh";
import {
  apiErrorMessage,
  documentStatusLabel,
  documentTypeLabel,
  orderStatusLabel,
} from "@visa-compass/shared";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = {};
type Order = {
  id: string;
  orderNumber: string;
  status: string;
  totalAmountNpr: number;
  createdAt: string;
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  plan: {
    name: string;
    countryCode: string;
    dataAllowance: string;
    validityDays: number;
  };
  documents: { id: string; type: string; status: string; fileName: string }[];
  payment?: { provider: string; status: string; reference?: string };
  timeline: { from: string | null; to: string; at: string; reason?: string }[];
  usage?: { usedMb: number; totalMb: number; lastCheckedAt?: string };
  provisioningFailure?: { code: string; message: string };
  documentReviewPolicy?: "AUTO_OCR" | "MANUAL_REVIEW" | "NO_REVIEW";
  documentReviewStatus?: string;
};

export default function EsimDetails({ id }: { id: string }) {
  const authFetch = useAuthenticatedFetch();
  const [order, setOrder] = useState<Order | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState("");
  const [replacements, setReplacements] = useState<
    Record<string, File | undefined>
  >({});
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [paymentCheckedAt, setPaymentCheckedAt] = useState<Date | null>(null);
  const load = useCallback(
    (isCurrent: () => boolean = () => true) =>
      authFetch(`${API}/customer/orders/${id}`, { headers }).then(
        async (response) => {
          const value = await response.json();
          if (!response.ok)
            throw new Error(
              apiErrorMessage(
                value.error?.code ?? "",
                "This eSIM could not be loaded.",
              ),
            );
          if (!isCurrent()) return;
          if (value.data.purchaseType === "TOPUP") {
            window.location.replace(
              `/esim/checkout?order=${encodeURIComponent(id)}&recharge=1`,
            );
            return;
          }
          setOrder(value.data);
          setLoadError("");
        },
      ),
    [authFetch, id],
  );
  useEffect(() => {
    let cancelled = false;
    setOrder(null);
    setLoadError("");
    void load(() => !cancelled).catch(() => {
      if (!cancelled)
        setLoadError(
          "This order could not be loaded. Check your connection and try again.",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [load, attempt]);
  useDocumentRefresh(
    Boolean(order) &&
      !busy &&
      ([
        "PAYMENT_PENDING",
        "PAYMENT_CONFIRMED",
        "REVIEW_PENDING",
        "APPROVED",
        "PROVISIONING",
      ].includes(order?.status ?? "") ||
        ["OCR_PENDING", "OCR_BACKGROUND", "MANUAL_REVIEW"].includes(
          order?.documentReviewStatus ?? "",
        )),
    async (isCurrent) => {
      await load(isCurrent);
    },
    () =>
      setLoadError(
        "Connection interrupted. Your order is saved. We’ll keep trying to refresh its status.",
      ),
    order?.documentReviewStatus === "MANUAL_REVIEW",
  );
  const uploadDocument = useRef(createDocumentUploader());
  const uploadReplacement = async (document: { id: string; type: string }) => {
    const file = replacements[document.id];
    if (!file || busy) return;
    if (file.size > 10 * 1024 * 1024)
      return setError("Document exceeds the 10 MB limit");
    if (
      !["application/pdf", "image/jpeg", "image/png"].includes(
        file.type || "application/pdf",
      )
    )
      return setError("Choose a PDF, JPG or PNG document");
    setBusy(document.id);
    setError("");
    try {
      await uploadDocument.current({
        type: document.type,
        file,
        basePath: `${API}/customer/orders/${id}/documents`,
        progress: setNotice,
        request: async <T,>(path: string, init?: RequestInit): Promise<T> => {
          const response = await authFetch(path, {
            ...init,
            headers: {
              "content-type": "application/json",
              "x-idempotency-key": crypto.randomUUID(),
            },
          });
          const value = await response.json();
          if (!response.ok)
            throw new Error(
              apiErrorMessage(
                value.error?.code ?? "",
                "Your document could not be saved. Please retry.",
              ),
            );
          return value.data;
        },
      });
      setReplacements((current) => {
        const next = { ...current };
        delete next[document.id];
        return next;
      });
      setNotice(
        "Replacement securely saved. Verification updates will appear here.",
      );
      await load();
    } catch (cause) {
      setNotice("");
      setError(
        cause instanceof Error ? cause.message : "Replacement upload failed",
      );
    } finally {
      setBusy("");
    }
  };
  const resendQrAction = async () => {
    setBusy("qr-resend");
    setError("");
    setNotice("");
    try {
      const response = await authFetch(
        `${API}/customer/orders/${id}/resend-qr`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: "{}",
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          apiErrorMessage(
            value.error?.code ?? "",
            "This eSIM request could not be completed.",
          ),
        );
      setNotice(
        "QR email sent — check your inbox (and spam) for the QR image.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The QR could not be resent",
      );
    } finally {
      setBusy("");
    }
  };
  const downloadQrAction = async () => {
    setBusy("qr-download");
    setError("");
    setNotice("");
    try {
      const response = await authFetch(
        `${API}/customer/orders/${id}/activation-qr`,
        { headers },
      );
      if (!response.ok) throw new Error("The QR document could not be loaded");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${order?.orderNumber ?? "esim"}-esim.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice("QR PDF downloaded. No password is required.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The QR document could not be loaded",
      );
    } finally {
      setBusy("");
    }
  };
  const checkPaymentStatus = async () => {
    if (!order?.payment?.reference || busy) return;
    setBusy("payment-status");
    setError("");
    try {
      const response = await authFetch(
        `${API}/customer/orders/${id}/payment/verify`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ reference: order.payment.reference }),
        },
      );
      const value = await response.json();
      if (!response.ok) {
        await load();
        throw new Error(
          apiErrorMessage(
            value.error?.code ?? "",
            "We could not confirm the payment status. Please try again shortly.",
          ),
        );
      }
      setOrder(value.data);
      setPaymentCheckedAt(new Date());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not confirm the payment status. Please try again shortly.",
      );
    } finally {
      setBusy("");
    }
  };
  if (loadError && !order)
    return (
      <main className="section">
        <div className="account-empty" role="alert">
          <h1>We could not load this order</h1>
          <p>{loadError}</p>
          <div className="form-actions">
            <button
              className="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
            <Link className="button secondary" href="/account/orders">
              View orders
            </Link>
          </div>
        </div>
      </main>
    );
  if (!order)
    return (
      <main className="account-loading" role="status">
        <LoaderCircle className="spin" />
        Loading secure order…
      </main>
    );
  const resumable = ["DRAFT", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(
    order.status,
  );
  const paymentPending =
    order.status === "PAYMENT_PENDING" && Boolean(order.payment?.reference);
  const needsReupload = order.documents.some(
    (document) => document.status === "REUPLOAD_REQUIRED",
  );
  const documentReviewPending = [
    "OCR_PENDING",
    "MANUAL_REVIEW",
    "OCR_BACKGROUND",
  ].includes(order.documentReviewStatus ?? "");
  const resumeLabel = order.status === "PAYMENT_FAILED"
      ? "Retry payment"
      : "Resume checkout";
  return (
    <main className="detail-page">
      <div className="shell">
        <Link className="back-link-detail" href="/account/orders">
          <ChevronLeft size={16} />
          Orders
        </Link>
        <div className="detail-head">
          <div>
            <span className={`status-chip ${order.status.toLowerCase()}`}>
              {orderStatusLabel(order.status)}
            </span>
            <h1>{order.plan.name}</h1>
            <p>
              {order.orderNumber} · Created{" "}
              {new Date(order.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="detail-price">
            <small>Order total</small>
            <b>NPR {order.totalAmountNpr.toLocaleString()}</b>
          </div>
        </div>
        {loadError && (
          <div className="qr-notice" role="status">
            {loadError}
          </div>
        )}
        {error && <ErrorModal error={error} onClose={() => setError("")} />}
        {notice && (
          <div className="qr-notice ok" role="status">
            {notice}
          </div>
        )}
        {paymentPending ? (
          <section className="customer-action-banner">
            <Clock3 />
            <span>
              <b>Awaiting payment confirmation</b>
              <small>
                {paymentCheckedAt
                  ? `Checked at ${paymentCheckedAt.toLocaleTimeString()}. The payment has not been confirmed yet.`
                  : "Completed the payment in your banking app or wallet? Check its latest status here."}
              </small>
            </span>
            <button
              className="button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void checkPaymentStatus()}
            >
              {busy === "payment-status" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <CheckCircle2 size={17} />
              )}
              {busy === "payment-status" ? "Checking status" : "Check status"}
            </button>
          </section>
        ) : resumable ? (
          <section className="customer-action-banner">
            <AlertCircle />
            <span>
              <b>Complete your purchase</b>
              <small>
                {order.status === "PAYMENT_FAILED"
                  ? "The previous payment did not complete. Return to checkout to choose a payment method and try again."
                  : "Your saved traveller and document information will be restored."}
              </small>
            </span>
            <Link className="button" href={`/esim/checkout?order=${order.id}`}>
              {resumeLabel}
            </Link>
          </section>
        ) : null}
        {needsReupload && (
          <section className="customer-action-banner warning">
            <Upload />
            <span>
              <b>Replacement document required</b>
              <small>
                {[...order.timeline]
                  .reverse()
                  .find((event) => event.to === "AWAITING_CUSTOMER")?.reason ??
                  "Upload the requested document to submit the order again."}
              </small>
            </span>
          </section>
        )}
        {documentReviewPending && !needsReupload && (
          <section className="customer-action-banner">
            <Clock3 />
            <span>
              <b>
                {order.documentReviewStatus === "MANUAL_REVIEW"
                  ? "Documents awaiting review"
                  : "Checking your documents"}
              </b>
              <small>
                {order.payment?.status === "COMPLETED"
                  ? "Your payment has been received. Document review updates will appear here automatically."
                  : "Your documents are saved. Payment becomes available after verification succeeds. This page updates automatically."}
              </small>
            </span>
          </section>
        )}
        <div className="detail-grid">
          <div className="detail-column">
            <section className="detail-card">
              <h2>Order progress</h2>
              <div className="timeline">
                {[...order.timeline].reverse().map((event, index) => (
                  <div
                    key={`${event.at}-${index}`}
                    className={index === 0 ? "current" : ""}
                  >
                    <i>
                      {index === 0 ? (
                        <Clock3 size={15} />
                      ) : (
                        <CheckCircle2 size={15} />
                      )}
                    </i>
                    <span>
                      <b>{orderStatusLabel(event.to)}</b>
                      <small>
                        {new Date(event.at).toLocaleString()}
                        {event.reason ? ` · ${event.reason}` : ""}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <section className="detail-card">
              <h2>Documents</h2>
              {order.documents.map((document) => (
                <div
                  className={`document-row ${document.status === "REUPLOAD_REQUIRED" ? "requires-upload" : ""}`}
                  key={document.id}
                >
                  <span>
                    {documentTypeLabel(document.type)} · {document.fileName}
                  </span>
                  <b>{documentStatusLabel(document.status)}</b>
                  {document.status === "REUPLOAD_REQUIRED" && (
                    <div className="replacement-control">
                      <input
                        type="file"
                        disabled={Boolean(busy)}
                        aria-label={`Replace ${documentTypeLabel(document.type)}`}
                        accept="application/pdf,image/jpeg,image/png"
                        onChange={(event) =>
                          setReplacements((value) => ({
                            ...value,
                            [document.id]: event.target.files?.[0],
                          }))
                        }
                      />
                      <button
                        className="button"
                        disabled={Boolean(busy) || !replacements[document.id]}
                        onClick={() => uploadReplacement(document)}
                      >
                        {busy === document.id ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <Upload size={16} />
                        )}
                        Upload replacement
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          </div>
          <aside className="activation-card">
            <span className="form-icon">
              <QrCode />
            </span>
            <h2>
              {paymentPending
                ? "What happens next"
                : resumable
                  ? "Purchase incomplete"
                  : "eSIM activation"}
            </h2>
            {paymentPending ? (
              <>
                <p>
                  Your eSIM will be prepared only after the payment provider
                  confirms the transaction. You do not need to start another
                  payment while this one is pending.
                </p>
                <div className="processing">
                  <Clock3 size={18} /> Payment confirmation pending
                </div>
              </>
            ) : resumable ? (
              <>
                <p>
                  Continue checkout to finish the remaining details and
                  payment.
                </p>
                <Link
                  className="button"
                  href={`/esim/checkout?order=${order.id}`}
                >
                  {resumeLabel}
                </Link>
              </>
            ) : order.status === "QR_READY" &&
              order.purchaseType === "TOPUP" ? (
              <>
                <p>
                  This package has been added to your existing eSIM. You do not
                  need to install or scan another QR code.
                </p>
                <div className="processing">
                  <CheckCircle2 size={18} />
                  Package added — waiting for first data use
                </div>
              </>
            ) : order.status === "QR_READY" ? (
              <>
                <p>
                  Your activation QR was emailed to you as an image. Install the
                  eSIM and connect once to activate it — your order will then be
                  marked complete.
                </p>
                <div className="processing">
                  <QrCode size={18} />
                  Activation QR delivered — awaiting activation
                </div>
                <div className="qr-recovery">
                  <b>Did the QR email not arrive?</b>
                  <small>
                    Resend the QR image or download an unencrypted PDF here. No
                    password is required.
                  </small>
                  <div className="qr-recovery-buttons">
                    <button
                      className="button secondary"
                      disabled={Boolean(busy)}
                      onClick={() => void resendQrAction()}
                    >
                      {busy === "qr-resend" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Mail size={16} />
                      )}{" "}
                      Resend email
                    </button>
                    <button
                      className="button"
                      disabled={Boolean(busy)}
                      onClick={() => void downloadQrAction()}
                    >
                      {busy === "qr-download" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <QrCode size={16} />
                      )}{" "}
                      Download QR PDF
                    </button>
                  </div>
                </div>
              </>
            ) : order.status === "COMPLETED" &&
              order.purchaseType === "TOPUP" ? (
              <>
                <p>
                  Your top-up is active on the existing eSIM. No new QR code or
                  installation is required.
                </p>
                <div className="processing">
                  <CheckCircle2 size={18} /> Top-up activated
                </div>
              </>
            ) : order.status === "COMPLETED" ? (
              <>
                <p>
                  Your activation QR was emailed to you as an image. Open it on
                  another screen and scan it from your phone&apos;s eSIM
                  settings.
                </p>
                <div className="processing">
                  <Mail size={18} />
                  Check your email for the attachment
                </div>
                <div className="qr-recovery">
                  <b>Did the QR email not arrive?</b>
                  <small>
                    Resend the QR image or download an unencrypted PDF here. No
                    password is required.
                  </small>
                  <div className="qr-recovery-buttons">
                    <button
                      className="button secondary"
                      disabled={Boolean(busy)}
                      onClick={() => void resendQrAction()}
                    >
                      {busy === "qr-resend" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Mail size={16} />
                      )}{" "}
                      Resend email
                    </button>
                    <button
                      className="button"
                      disabled={Boolean(busy)}
                      onClick={() => void downloadQrAction()}
                    >
                      {busy === "qr-download" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <QrCode size={16} />
                      )}{" "}
                      Download QR PDF
                    </button>
                  </div>
                </div>
                {order.usage ? (
                  <div className="usage-panel">
                    <span className="form-icon">
                      <Clock3 />
                    </span>
                    <h3>Data usage</h3>
                    <div className="usage-bar">
                      <i
                        style={{
                          width: `${Math.min(
                            100,
                            (order.usage.usedMb / order.usage.totalMb) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                    <p>
                      <b>{formatDataMb(order.usage.usedMb)}</b> of{" "}
                      {formatDataMb(order.usage.totalMb)} used
                    </p>
                    <small>
                      Remaining:{" "}
                      {formatDataMb(Math.max(
                        0,
                        order.usage.totalMb - order.usage.usedMb,
                      ))} · last checked{" "}
                      {order.usage.lastCheckedAt
                        ? new Date(order.usage.lastCheckedAt).toLocaleString()
                        : "—"}
                    </small>
                  </div>
                ) : (
                  <p className="usage-pending">
                    Usage will appear here after your plan is activated and
                    reconciled.
                  </p>
                )}
              </>
            ) : order.status === "PAYMENT_REVIEW_REQUIRED" ? (
              <p>
                Your payment needs confirmation. Our operations team can recheck
                it without creating another charge.
              </p>
            ) : order.status === "ACTIVATION_ATTENTION" ? (
              <p>
                Your QR remains available. Network activation confirmation is
                delayed and our operations team is reconciling it.
              </p>
            ) : order.status === "PROVISIONING_FAILED" ? (
              <>
                <p>
                  {order.provisioningFailure?.message ??
                    "We could not activate your eSIM right now. Our team is reviewing it and will contact you."}
                </p>
                <div className="processing">
                  <AlertTriangle size={18} />
                  Activation unsuccessful
                </div>
                <div className="qr-recovery">
                  <b>Need help?</b>
                  <small>
                    Our team reviews failed activations. You can also choose
                    another plan without being charged.
                  </small>
                  <div className="qr-recovery-buttons">
                    <Link className="button" href="/destinations">
                      Choose another plan
                    </Link>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p>
                  {needsReupload
                    ? "Upload the requested replacement. The order returns to review automatically."
                    : "Your eSIM is being activated automatically after payment. You will receive your QR by email."}
                </p>
                <div className="processing">
                  <LoaderCircle size={18} />
                  {needsReupload
                    ? "Waiting for your document"
                    : "Securely processing"}
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
