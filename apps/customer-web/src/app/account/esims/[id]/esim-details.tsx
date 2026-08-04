"use client";
import { useAuthenticatedFetch } from "../../../authenticated-api-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  LoaderCircle,
  Mail,
  QrCode,
  Upload,
} from "lucide-react";
import "./recovery.css";
import { apiErrorMessage } from "@visa-compass/shared";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = {};
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
  payment?: { provider: string; status: string };
  timeline: { from: string | null; to: string; at: string; reason?: string }[];
};

export default function EsimDetails({ id }: { id: string }) {const authFetch=useAuthenticatedFetch();
  const [order, setOrder] = useState<Order | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const [replacements, setReplacements] = useState<
    Record<string, File | undefined>
  >({});
  const load = () =>
    authFetch(`${API}/customer/orders/${id}`, { headers }).then(
      async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(apiErrorMessage(value.error?.code ?? "", value.error?.message ?? "Something went wrong"));
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
        throw new Error(apiErrorMessage(authorizationValue.error?.code ?? "", authorizationValue.error?.message ?? "Something went wrong"));
      const authorization = authorizationValue.data as DocumentAuthorization;
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
      if (!confirmation.ok) throw new Error(apiErrorMessage(confirmationValue.error?.code ?? "", confirmationValue.error?.message ?? "Something went wrong"));
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
  if (error && !order)
    return (
      <main className="section">
        <div className="shell form-error">{error}</div>
      </main>
    );
  if (!order)
    return (
      <main className="account-loading">
        <LoaderCircle className="spin" />
        Loading secure order…
      </main>
    );
  const resumable = ["DRAFT", "PAYMENT_PENDING"].includes(order.status);
  const needsReupload = order.status === "AWAITING_CUSTOMER";
  return (
    <main className="detail-page">
      <div className="shell">
        <Link className="back-link-detail" href="/account/esims">
          <ChevronLeft size={16} />
          My eSIMs
        </Link>
        <div className="detail-head">
          <div>
            <span className={`status-chip ${order.status.toLowerCase()}`}>
              {order.status.replaceAll("_", " ")}
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
        {error && <div className="form-error">{error}</div>}
        {resumable && (
          <section className="customer-action-banner">
            <AlertCircle />
            <span>
              <b>Complete your purchase</b>
              <small>
                Your saved traveller and document information will be restored.
              </small>
            </span>
            <Link className="button" href={`/esim/checkout?order=${order.id}`}>
              Resume checkout
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
                      <b>{event.to.replaceAll("_", " ")}</b>
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
                    {document.type} · {document.fileName}
                  </span>
                  <b>{document.status}</b>
                  {needsReupload && document.status === "REUPLOAD_REQUIRED" && (
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
                  Continue checkout to submit traveller documents and complete
                  payment.
                </p>
                <Link
                  className="button"
                  href={`/esim/checkout?order=${order.id}`}
                >
                  Resume purchase
                </Link>
              </>
            ) : order.status === "COMPLETED" ? (
              <>
                <p>
                  Your activation QR was emailed to you as a password-protected
                  PDF. Open the PDF on your phone and enter the mobile number
                  you provided to reveal the QR.
                </p>
                <div className="processing">
                  <Mail size={18} />
                  Check your email for the attachment
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
