"use client";
import { useAuthenticatedFetch } from "../../../authenticated-api-provider";
import ErrorModal from "../../../../components/error-modal";
import { useEffect, useState } from "react";
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
import {
  apiErrorMessage,
  documentStatusLabel,
  documentTypeLabel,
  orderStatusLabel,
} from "@visa-compass/shared";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = {};
type DocumentAuthorization = {
  id: string;
  upload: {
    mode: string;
    endpoint?: string;
    method?: "PUT";
    headers?: Record<string, string>;
  };
};
type Order = {
  id: string;
  orderNumber: string;
  status: string;
  totalAmountNpr: number;
  createdAt: string;
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
  const load = () =>
    authFetch(`${API}/customer/orders/${id}`, { headers }).then(
      async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            apiErrorMessage(
              value.error?.code ?? "",
              value.error?.message ?? "Something went wrong",
            ),
          );
        setOrder(value.data);
      },
    );
  useEffect(() => {
    void load().catch((cause) => setError(cause.message));
  }, [id]);
  const uploadReplacement = async (document: { id: string; type: string }) => {
    const file = replacements[document.id];
    if (!file) return setError("Choose a replacement file first");
    if (file.size > 10 * 1024 * 1024)
      return setError("Document exceeds the 10 MB limit");
    setBusy(document.id);
    setError("");
    try {
      const authorizationResponse = await authFetch(
        `${API}/customer/orders/${id}/documents`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            type: document.type,
            fileName: file.name,
            contentType: file.type || "application/pdf",
          }),
        },
      );
      const authorizationValue = await authorizationResponse.json();
      if (!authorizationResponse.ok)
        throw new Error(
          apiErrorMessage(
            authorizationValue.error?.code ?? "",
            authorizationValue.error?.message ?? "Something went wrong",
          ),
        );
      const authorization = authorizationValue.data as DocumentAuthorization;
      if (
        authorization.upload.mode !== "s3-presigned" ||
        !authorization.upload.endpoint
      )
        throw new Error("Private document storage is unavailable");
      const uploaded = await fetch(authorization.upload.endpoint, {
        method: authorization.upload.method ?? "PUT",
        ...(authorization.upload.headers
          ? { headers: authorization.upload.headers }
          : {}),
        body: file,
      });
      if (!uploaded.ok) throw new Error("Replacement upload failed");
      const confirmation = await authFetch(
        `${API}/customer/orders/${id}/documents/${authorization.id}/confirm`,
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
      const confirmationValue = await confirmation.json();
      if (!confirmation.ok)
        throw new Error(
          apiErrorMessage(
            confirmationValue.error?.code ?? "",
            confirmationValue.error?.message ?? "Something went wrong",
          ),
        );
      setReplacements({});
      await load();
    } catch (cause) {
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
            value.error?.message ?? "Something went wrong",
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
  if (error && !order)
    return (
      <main className="section">
        <ErrorModal error={error} onClose={() => setError("")} />
      </main>
    );
  if (!order)
    return (
      <main className="account-loading">
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
  const documentReviewPending = ["MANUAL_REVIEW", "OCR_BACKGROUND"].includes(
    order.documentReviewStatus ?? "",
  );
  const resumeLabel = paymentPending
    ? "Check payment status"
    : order.status === "PAYMENT_FAILED"
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
        {error && <ErrorModal error={error} onClose={() => setError("")} />}
        {notice && <div className="qr-notice ok">{notice}</div>}
        {resumable && (
          <section className="customer-action-banner">
            <AlertCircle />
            <span>
              <b>
                {paymentPending
                  ? "Confirm your payment"
                  : "Complete your purchase"}
              </b>
              <small>
                {paymentPending
                  ? "Your payment returned to us but is still being confirmed. We re-check it automatically."
                  : "Your saved traveller and document information will be restored."}
              </small>
            </span>
            <Link className="button" href={`/esim/checkout?order=${order.id}`}>
              {resumeLabel}
            </Link>
          </section>
        )}
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
              <b>Your documents are being reviewed separately</b>
              <small>
                Your payment and eSIM activation continue normally. Our team
                will contact you only if another document is required.
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
                        disabled={busy === document.id}
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
            <h2>{resumable ? "Purchase incomplete" : "eSIM activation"}</h2>
            {resumable ? (
              <>
                <p>
                  {paymentPending
                    ? "We re-check the payment with your wallet automatically and will activate the eSIM as soon as it is confirmed."
                    : "Continue checkout to submit traveller documents and complete payment."}
                </p>
                <Link
                  className="button"
                  href={`/esim/checkout?order=${order.id}`}
                >
                  {resumeLabel}
                </Link>
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
                      <b>{order.usage.usedMb.toLocaleString()} MB</b> of{" "}
                      {order.usage.totalMb.toLocaleString()} MB used
                    </p>
                    <small>
                      Remaining:{" "}
                      {Math.max(
                        0,
                        order.usage.totalMb - order.usage.usedMb,
                      ).toLocaleString()}{" "}
                      MB · last checked{" "}
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
                    <Link className="button" href="/#plans">
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
