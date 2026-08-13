"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { opsHeaders, type OpsOrder } from "../orders-client";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/spinner";
import { InfoRow } from "@/components/info-row";
import { Panel } from "@/components/panel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ManualRefundCard } from "./manual-refund-card";

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
  payment?: { provider: string; status: string; reference?: string; providerTransactionId?: string };
  timeline: { to: string; at: string; reason?: string }[];
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  topUpMobile?: string;
  assignment?: { inventoryId?: string; iccid?: string; msisdn?: string; providerSubscriptionId?: string; verificationStatus?: string; verifiedAt?: string; providerLastSeenAt?: string };
};

export default function OrderReview({ id }: { id: string }) {
  const authFetch = useAuthenticatedFetch();
  const [order, setOrder] = useState<Detail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("Please upload a clearer, complete copy");
  const [confirmAction, setConfirmAction] = useState<{
    kind: "cancel";
    reason: string;
  } | null>(null);
  const [previewDocument, setPreviewDocument] = useState<{
    url: string;
    fileName: string;
    contentType: string;
  } | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setPreviewDocument({
      url: URL.createObjectURL(blob),
      fileName:
        response.headers
          .get("content-disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "Travel document",
      contentType: blob.type,
    });
  };

  if (!order)
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner /> {error || "Loading secure order…"}
        </div>
      </div>
    );

  const canReview = order.status === "REVIEW_PENDING";
  const requiredApproved = ["PASSPORT", "TICKET"].every((type) =>
    order.documents.some(
      (document) => document.type === type && document.status === "APPROVED",
    ),
  );
  const decisionTone = (status: string) =>
    status === "COMPLETED"
      ? "success"
      : status === "REVIEW_PENDING"
        ? "warning"
        : status.includes("FAIL")
          ? "danger"
          : status.includes("REFUND") || status.includes("CANCEL")
            ? "destructive"
            : "info";

  return (
    <>
      <Dialog open={!!previewDocument} onOpenChange={(open) => { if (!open && previewDocument) { URL.revokeObjectURL(previewDocument.url); setPreviewDocument(null); } }}>
        <DialogContent className="max-w-4xl" showCloseButton={false}>
          <DialogTitle className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate font-semibold">{previewDocument?.fileName}</p>
              <p className="text-xs font-normal text-muted-foreground">
                Authenticated preview · not cached
              </p>
            </div>
          </DialogTitle>
          {previewDocument?.contentType === "application/pdf" ? (
            <iframe
              src={previewDocument.url}
              title="Secure PDF travel document"
              className="h-[70vh] w-full rounded-lg border"
            />
          ) : (
            <img
              src={previewDocument?.url}
              alt="Secure travel document preview"
              className="mx-auto max-h-[70vh] rounded-lg"
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Cancel order
            </DialogTitle>
            <DialogDescription>
              This transition is appended to the immutable timeline and cannot
              be undone. A reason is required for the record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Reason (shown in the timeline)
            </Label>
            <textarea
              value={confirmAction?.reason ?? ""}
              onChange={(event) =>
                setConfirmAction((state) =>
                  state ? { ...state, reason: event.target.value } : state,
                )
              }
              rows={3}
              className="w-full rounded-md border border-input bg-transparent p-3 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => setConfirmAction(null)}
            >
              Keep order
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busy) || !confirmAction?.reason.trim()}
              onClick={() => {
                if (confirmAction?.kind === "cancel") action("cancel", { reason: confirmAction.reason.trim() });
                setConfirmAction(null);
              }}
            >
              {busy ? <Spinner /> : null}
              Confirm cancellation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Link
        href="/work-queue"
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Work queue
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{order.orderNumber}</h1>
        <StatusBadge label={order.status} tone={decisionTone(order.status)} />
        <Badge variant={order.purchaseType === "TOPUP" ? "info" : "secondary"}>
          {order.purchaseType === "TOPUP" ? "TOP-UP" : "FIRST PURCHASE"}
        </Badge>
      </div>
      <p className="-mt-4 mb-6 text-sm text-muted-foreground">
        {order.plan.name} · NPR {order.totalAmountNpr.toLocaleString()}
        {order.topUpMobile ? ` · top-up for ${order.topUpMobile}` : ""}
      </p>

      {error && (
        <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {order.purchaseType === "TOPUP" && (
            <Panel title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" />Top-up verification</span>}>
              <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
                Khalti payment is captured only after its lookup reports <strong className="text-foreground">COMPLETED</strong>. The provider then adds this plan to the existing eSIM; assignment becomes verified only after Transatel confirms the subscription on that ICCID.
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <InfoRow label="Target mobile" value={order.topUpMobile ?? order.assignment?.msisdn ?? "Unavailable"}/>
                <InfoRow label="Payment capture" value={order.payment?.status === "COMPLETED" ? "Confirmed by Khalti" : order.payment?.status ?? "Not started"}/>
                <InfoRow label="Khalti reference" value={order.payment?.providerTransactionId ?? order.payment?.reference ?? "Pending"}/>
                <InfoRow label="Provider verification" value={order.assignment?.verificationStatus ?? "Pending provisioning"}/>
                <InfoRow label="Existing ICCID" value={order.assignment?.iccid ?? "Resolved during provisioning"}/>
                <InfoRow label="Provider subscription" value={order.assignment?.providerSubscriptionId ?? "Awaiting Transatel"}/>
              </dl>
            </Panel>
          )}
          <Panel
            title={
              <span className="flex items-center gap-2">
                <UserRound className="size-4 text-primary" />
                Traveller
              </span>
            }
          >
            {order.traveler ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <InfoRow
                  label="Name"
                  value={`${order.traveler.title} ${order.traveler.firstName} ${order.traveler.middleName ?? ""} ${order.traveler.surname}`}
                />
                <InfoRow label="Date of birth" value={order.traveler.dateOfBirth} />
                <InfoRow label="Passport" value={order.traveler.passportNumber} />
                <InfoRow label="Passport expiry" value={order.traveler.passportExpiryDate} />
                <InfoRow
                  label="Residence"
                  value={`${order.traveler.city}, ${order.traveler.countryOfResidence}`}
                />
                <InfoRow
                  label="Contact"
                  value={`${order.traveler.email} · ${order.traveler.mobile}`}
                />
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Traveller details incomplete</p>
            )}
          </Panel>

          <Panel title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" />eSIM assignment</span>}>
            {order.assignment ? <div className="space-y-4"><div className="flex flex-wrap gap-2"><Badge variant={order.assignment.verificationStatus === "VERIFIED" ? "success" : order.assignment.verificationStatus === "MISMATCH" ? "destructive" : "secondary"}>{order.assignment.verificationStatus ?? "PENDING"}</Badge>{order.traveler?.passportExpiryDate && <Badge variant={new Date(order.traveler.passportExpiryDate) > new Date() ? "success" : "destructive"}>{new Date(order.traveler.passportExpiryDate) > new Date() ? "PASSPORT VALID" : "PASSPORT EXPIRED"}</Badge>}</div><dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2"><InfoRow label="ICCID" value={order.assignment.iccid ?? "—"}/><InfoRow label="MSISDN" value={order.assignment.msisdn ?? "—"}/><InfoRow label="Provider subscription" value={order.assignment.providerSubscriptionId ?? "Awaiting provider"}/><InfoRow label="Last provider confirmation" value={order.assignment.providerLastSeenAt ? new Date(order.assignment.providerLastSeenAt).toLocaleString() : "Pending"}/></dl></div>:<p className="text-sm text-muted-foreground">Plan has not been assigned to an eSIM yet.</p>}
          </Panel>

          <Panel
            title={
              <span className="flex items-center gap-2">
                <FileText className="size-4 text-primary" />
                Documents
              </span>
            }
            bodyClassName="space-y-1"
          >
            {order.documents.map((document) => (
              <div
                key={document.id}
                className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{document.type}</p>
                  <p className="truncate text-xs text-muted-foreground">{document.fileName}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge label={document.status} />
                  <Button size="sm" variant="outline" onClick={() => preview(document.id)}>
                    Preview
                  </Button>
                  {canReview && document.status !== "APPROVED" && (
                    <Button
                      size="sm"
                      variant="success"
                      disabled={Boolean(busy)}
                      onClick={() => action(`documents/${document.id}/approve`)}
                    >
                      {busy === `documents/${document.id}/approve` ? <Spinner className="text-success-foreground" /> : <CheckCircle2 className="size-4" />}
                      Approve
                    </Button>
                  )}
                  {canReview && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() => action(`documents/${document.id}/request-reupload`, { reason })}
                    >
                      <RefreshCcw className="size-4" />
                      Re-upload
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </Panel>

          <Panel title="Immutable timeline">
            <ol className="relative ml-2 space-y-6 border-l border-border pl-6">
              {[...order.timeline].reverse().map((event, index) => (
                <li key={`${event.at}-${index}`} className="relative">
                  <span className="absolute top-1 -left-[30px] flex size-2.5 items-center justify-center">
                    <span className="absolute size-2.5 rounded-full bg-border" />
                    <span className="relative size-1.5 rounded-full bg-primary" />
                  </span>
                  <p className="text-sm font-medium">{event.to.replaceAll("_", " ")}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(event.at).toLocaleString()}
                    {event.reason ? ` · ${event.reason}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <aside className="xl:col-span-1">
          <div className="sticky top-20 space-y-4 rounded-xl border bg-card p-5 shadow-card">
            <h2 className="text-base font-semibold">Review decision</h2>
            <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">Payment</span>
              <StatusBadge label={order.payment?.status ?? "NOT STARTED"} />
            </div>
            <p className="text-xs text-muted-foreground">
              Gateway: {order.payment?.provider ?? "—"}
            </p>
            {canReview ? (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Reason used for a document re-upload request
                  </Label>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-input bg-transparent p-3 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2"
                  />
                </div>
                <Button
                  className="w-full"
                  variant="success"
                  size="lg"
                  disabled={Boolean(busy) || !requiredApproved}
                  onClick={() => action("approve")}
                >
                  {busy === "approve" ? (
                    <Spinner className="text-success-foreground" />
                  ) : (
                    <ShieldCheck className="size-4" />
                  )}
                  {requiredApproved
                    ? "Approve & provision"
                    : "Approve passport and ticket first"}
                </Button>
              </>
            ) : order.status === "PROVISIONING_FAILED" ? (
              <div className="space-y-2"><Button className="w-full" variant="outline" size="lg" asChild><Link href="/provisioning-operations"><RefreshCcw className="size-4" />Check provider recovery</Link></Button><Button className="w-full" variant="success" size="lg" disabled={Boolean(busy)} onClick={() => action("retry")}>{busy === "retry" ? <Spinner className="text-success-foreground" /> : <RefreshCcw className="size-4" />}Retry known-safe failure</Button><p className="text-xs text-muted-foreground">Reconcile first when Transatel may have accepted the request. The API blocks unsafe duplicate submissions.</p></div>
            ) : ["QR_READY", "COMPLETED"].includes(order.status) ? (
              <Button
                className="w-full"
                variant="outline"
                size="lg"
                disabled={Boolean(busy)}
                onClick={() => action("resend-qr")}
              >
                {busy === "resend-qr" ? <Spinner /> : <QrCode className="size-4" />}
                Resend QR code
              </Button>
            ) : (
              <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                No review action available in this state.
              </div>
            )}
            <ManualRefundCard orderId={order.id} paid={order.payment?.status === "COMPLETED" && order.status !== "REFUNDED"} />
            {["DRAFT", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(order.status) && (
              <Button
                className="w-full text-destructive hover:bg-destructive/10"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() =>
                  setConfirmAction({ kind: "cancel", reason: "Customer request" })
                }
              >
                <AlertTriangle className="size-4" />
                Cancel order
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Every document decision and order transition is appended to the immutable timeline.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
