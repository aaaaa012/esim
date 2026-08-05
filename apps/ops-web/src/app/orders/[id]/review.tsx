"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCcw,
  UserRound,
} from "lucide-react";
import { opsHeaders, type OpsOrder } from "../orders-client";
import "./document-actions.css";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Detail = OpsOrder & {
  traveler?: {
    title: string;
    firstName: string;
    middleName?: string;
    surname: string;
    dateOfBirth: string;
    city: string;
    countryOfResidence: string;
    email: string;
    mobile: string;
    passportNumber: string;
    passportExpiryDate: string;
  };
  documents: { id: string; type: string; fileName: string; status: string }[];
  payment?: { provider: string; status: string };
  timeline: { to: string; at: string; reason?: string }[];
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  topUpMobile?: string;
};

export default function OrderReview({ id }: { id: string }) {const authFetch=useAuthenticatedFetch();
  const [order, setOrder] = useState<Detail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState(
    "Please upload a clearer, complete copy",
  );
  const [previewDocument, setPreviewDocument] = useState<{url:string;fileName:string;contentType:string}|null>(null);
  const load = () =>
    authFetch(`${API}/operations/orders/${id}`, { headers: opsHeaders }).then(
      async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error?.message);
        setOrder(value.data);
      },
    );
  useEffect(() => {
    void load().catch((error) => setError(error.message));
  }, [id]);
  const action = async (path: string, body?: object) => {
    setBusy(path);
    setError("");
    try {
      const response = await authFetch(`${API}/operations/orders/${id}/${path}`, {
        method: "POST",
        headers: {
          ...opsHeaders,
          "content-type": "application/json",
          "x-idempotency-key": crypto.randomUUID(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message);
      setOrder(value.data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy("");
    }
  };
  const preview = async (documentId: string) => {
    setError("");
    const response = await authFetch(
      `${API}/operations/orders/${id}/documents/${documentId}/content`,
      { headers: opsHeaders },
    );
    if (!response.ok) {
      setError("Document preview could not be loaded");
      return;
    }
    const blob = await response.blob();
    setPreviewDocument({url:URL.createObjectURL(blob),fileName:response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??'Travel document',contentType:blob.type});
  };
  if (!order)
    return (
      <div className="empty-table">
        {error || (
          <>
            <LoaderCircle className="spin" />
            Loading secure order…
          </>
        )}
      </div>
    );
  const canReview = order.status === "REVIEW_PENDING";
  const requiredApproved = ["PASSPORT", "TICKET"].every((type) =>
    order.documents.some(
      (document) => document.type === type && document.status === "APPROVED",
    ),
  );
  return (
    <>
      {previewDocument && <div className="document-preview-backdrop" role="dialog" aria-modal="true" aria-label="Secure document preview"><div className="document-preview-modal"><div><b>{previewDocument.fileName}</b><span>Authenticated preview · not cached</span><button onClick={() => {URL.revokeObjectURL(previewDocument.url);setPreviewDocument(null)}}>Close</button></div>{previewDocument.contentType==='application/pdf'?<iframe src={previewDocument.url} title="Secure PDF travel document"/>:<div className="document-image-stage"><img src={previewDocument.url} alt="Secure travel document preview"/></div>}</div></div>}
      <Link className="ops-back" href="/work-queue">
        <ChevronLeft size={15} />
        Work queue
      </Link>
      <div className="top review-top">
        <div>
          <span className={`pill ${canReview ? "green" : ""}`}>
            {order.status.replaceAll("_", " ")}
          </span>
          <span className={`pill ${order.purchaseType === "TOPUP" ? "topup" : "first"}`}>
            {order.purchaseType === "TOPUP" ? "TOP-UP" : "FIRST PURCHASE"}
          </span>
          <h1>{order.orderNumber}</h1>
          <p>
            {order.plan.name} · NPR {order.totalAmountNpr.toLocaleString()}
            {order.topUpMobile ? ` · top-up for ${order.topUpMobile}` : ""}
          </p>
        </div>
      </div>
      {error && <div className="ops-error">{error}</div>}
      <div className="review-grid">
        <div>
          <section className="panel review-card">
            <div className="panel-head">
              <h2>
                <UserRound size={16} />
                Traveller
              </h2>
            </div>
            {order.traveler ? (
              <dl className="info-grid">
                <Info
                  label="Name"
                  value={`${order.traveler.title} ${order.traveler.firstName} ${order.traveler.middleName ?? ""} ${order.traveler.surname}`}
                />
                <Info
                  label="Date of birth"
                  value={order.traveler.dateOfBirth}
                />
                <Info label="Passport" value={order.traveler.passportNumber} />
                <Info
                  label="Passport expiry"
                  value={order.traveler.passportExpiryDate}
                />
                <Info
                  label="Residence"
                  value={`${order.traveler.city}, ${order.traveler.countryOfResidence}`}
                />
                <Info
                  label="Contact"
                  value={`${order.traveler.email} · ${order.traveler.mobile}`}
                />
              </dl>
            ) : (
              <div className="empty-table">Traveller details incomplete</div>
            )}
          </section>
          <section className="panel review-card">
            <div className="panel-head">
              <h2>
                <FileText size={16} />
                Documents
              </h2>
            </div>
            {order.documents.map((document) => (
              <div className="review-doc" key={document.id}>
                <span>
                  <b>{document.type}</b>
                  <small>{document.fileName}</small>
                </span>
                <span className="doc-actions">
                  <span className="pill">{document.status}</span>
                  <button onClick={() => preview(document.id)}>
                    <ExternalLink size={13} />
                    Preview
                  </button>
                  {canReview && document.status !== "APPROVED" && (
                    <button
                      className="doc-approve"
                      disabled={Boolean(busy)}
                      onClick={() => action(`documents/${document.id}/approve`)}
                    >
                      <CheckCircle2 size={13} />
                      Approve
                    </button>
                  )}
                  {canReview && (
                    <button
                      className="doc-reupload"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        action(`documents/${document.id}/request-reupload`, {
                          reason,
                        })
                      }
                    >
                      <RefreshCcw size={13} />
                      Re-upload
                    </button>
                  )}
                </span>
              </div>
            ))}
          </section>
          <section className="panel review-card">
            <div className="panel-head">
              <h2>Immutable timeline</h2>
            </div>
            <div className="ops-timeline">
              {[...order.timeline].reverse().map((event, index) => (
                <div key={`${event.at}-${index}`}>
                  <i />
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
        </div>
        <aside className="decision-card">
          <h2>Review decision</h2>
          <p>
            Payment: <b>{order.payment?.status ?? "NOT STARTED"}</b> via{" "}
            {order.payment?.provider ?? "—"}
          </p>
          {canReview ? (
            <>
              <label>
                Reason used for a document re-upload request
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                className="decision approve"
                disabled={Boolean(busy) || !requiredApproved}
                onClick={() => action("approve")}
              >
                <CheckCircle2 size={17} />
                {busy
                  ? "Processing…"
                  : requiredApproved
                    ? "Approve & provision"
                    : "Approve passport and ticket first"}
              </button>
            </>
          ) : order.status === "PROVISIONING_FAILED" ? (
            <button
              className="decision approve"
              disabled={Boolean(busy)}
              onClick={() => action("retry")}
            >
              <RefreshCcw size={16} />
              Retry provisioning
            </button>
          ) : (
            <div className="decision-complete">
              <AlertTriangle size={18} />
              No review action available in this state.
            </div>
          )}
          {order.payment?.status === "COMPLETED" &&
            !["REFUND_PENDING", "REFUNDED"].includes(order.status) && (
              <button
                className="decision refund"
                disabled={Boolean(busy)}
                onClick={() =>
                  action("payment/refund", {
                    reason: prompt("Reason for refund", "Customer requested cancellation") ?? "Customer requested refund",
                  })
                }
              >
                <RefreshCcw size={16} />
                Refund order
              </button>
            )}
          {["DRAFT", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(order.status) && (
            <button
              className="decision cancel"
              disabled={Boolean(busy)}
              onClick={() =>
                action("cancel", {
                  reason: prompt("Reason for cancellation", "Customer request") ?? "Customer request",
                })
              }
            >
              <AlertTriangle size={16} />
              Cancel order
            </button>
          )}
          <small>
            Every document decision and order transition is appended to the
            immutable timeline.
          </small>
        </aside>
      </div>
    </>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
