"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useCallback, useEffect, useState } from "react";
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
import { StatusBadge, humane } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/spinner";
import { InfoRow } from "@/components/info-row";
import ErrorDialog from "@/components/error-dialog";
import { Panel } from "@/components/panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ManualRefundCard } from "./manual-refund-card";
import { useConfirmation } from "@/components/confirmation-provider";
import {
  documentReviewLabel,
  orderEventLabel,
  orderSourceLabel,
} from "./review-status";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Detail = OpsOrder & {
  providerStatus?: string;
  customer?: {
    id: string;
    customerCode: string;
    email: string;
    phone?: string | null;
    source: string;
    status: string;
    createdAt: string;
  };
  loginAccount?: {
    id: string;
    email: string;
    status: string;
    accountType: string;
    createdAt: string;
  } | null;
  partnerCustomer?: {
    id: string;
    externalCustomerId: string;
    partner: { id: string; code: string; name: string };
  } | null;
  qrDelivery?: {
    lastSuccessfulAt: string | null;
    pending: boolean;
  };
  documentReviewPolicy?: "AUTO_OCR" | "MANUAL_REVIEW" | "NO_REVIEW";
  documentReviewStatus?: string;
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
  documents: {
    id: string;
    type: string;
    fileName: string;
    status: string;
    uploadVerified?: boolean;
  }[];
  passportVerification?: { status: string };
  payment?: {
    provider: string;
    status: string;
    reference?: string;
    providerTransactionId?: string;
  };
  timeline: { from?: string | null; to: string; at: string; reason?: string }[];
  purchaseType?: "INITIAL_PURCHASE" | "TOPUP";
  purchasedBy?: { id: string; email: string } | null;
  targetInventoryId?: string | null;
  topUpMobile?: string;
  assignment?: {
    inventoryId?: string;
    iccid?: string;
    msisdn?: string;
    providerSubscriptionId?: string;
    verificationStatus?: string;
    verifiedAt?: string;
    providerLastSeenAt?: string;
  };
  packageUsage?: UsagePackage | null;
  esimUsage?: EsimUsage | null;
};
type UsagePackage = {
  usedMb: number;
  totalMb: number;
  remainingMb: number;
  balanceStatus: string;
  status: string;
  lastConfirmedAt: string | null;
};
type EsimUsage = {
  usageStatus: string;
  completeness: string;
  freshness: string;
  lastConfirmedAt: string | null;
  summary: {
    usedMb: number;
    totalMb: number;
    remainingMb: number;
    confirmedPackageCount: number;
    unconfirmedPackageCount: number;
    packageCount: number;
  };
};
type ProviderCheck = {
  classification: string;
  orderStatus: string;
  provisioningState?: string | null;
  profileStatus: string;
  subscriberStatus?: string | null;
  subscriptionStatus?: string | null;
  checkedAt: string;
  recommendedAction: string;
};

export default function OrderReview({ id }: { id: string }) {
  const authFetch = useAuthenticatedFetch();
  const confirm = useConfirmation();
  const [order, setOrder] = useState<Detail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [providerCheck, setProviderCheck] = useState<ProviderCheck | null>(
    null,
  );
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [reason, setReason] = useState(
    "Please upload a clearer, complete copy",
  );
  const [confirmAction, setConfirmAction] = useState<{
    kind: "cancel" | "reject-documents";
    reason: string;
  } | null>(null);
  const [previewDocument, setPreviewDocument] = useState<{
    url: string;
    fileName: string;
    contentType: string;
  } | null>(null);

  const load = useCallback(
    () =>
      authFetch(`${API}/operations/orders/${id}`, {
        headers: opsHeaders,
      }).then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error?.message);
        setOrder(value.data);
      }),
    [authFetch, id],
  );
  useEffect(() => {
    void load().catch((error) => setError(error.message));
    void authFetch(`${API}/auth/me`, { headers: {} })
      .then((response) => response.json())
      .then((value) =>
        setIsSuperAdmin(value.data?.accountType === "SUPER_ADMIN"),
      );
  }, [authFetch, load]);
  const action = async (path: string, body?: object) => {
    setBusy(path);
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/orders/${id}/${path}`,
        {
          method: "POST",
          headers: {
            ...opsHeaders,
            "content-type": "application/json",
            "x-idempotency-key": crypto.randomUUID(),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message);
      // Mutation responses omit the operations identity and usage context.
      await load();
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
  const checkProvider = async () => {
    if (
      !(await confirm({
        title: "Refresh status from Transatel?",
        description:
          "This only reads the latest eSIM and subscription status. It does not activate, recharge, suspend, or charge anything.",
        confirmLabel: "Refresh network status",
      }))
    )
      return;
    setBusy("provider-status-check");
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/orders/${id}/provider-status-check`,
        {
          method: "POST",
          headers: { "x-idempotency-key": crypto.randomUUID() },
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Provider check failed");
      setProviderCheck(value.data);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Provider check failed",
      );
    } finally {
      setBusy("");
    }
  };
  const refreshUsage = async () => {
    setBusy("usage-refresh");
    setError("");
    try {
      const response = await authFetch(
        `${API}/operations/orders/${id}/usage/refresh`,
        {
          method: "POST",
          headers: { "x-idempotency-key": crypto.randomUUID() },
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "Usage refresh failed");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Usage refresh failed");
    } finally {
      setBusy("");
    }
  };

  if (!order)
    return (
      <>
        <ErrorDialog error={error} onClose={() => setError("")} />
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
          {error ? (
            <>
              <p className="max-w-md text-center text-sm text-muted-foreground">
                Could not load this order. Please try again.
              </p>
              <Button
                onClick={() => {
                  setError("");
                  void load().catch((loadError: unknown) =>
                    setError(
                      loadError instanceof Error
                        ? loadError.message
                        : "Could not load this order",
                    ),
                  );
                }}
              >
                Try again
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Spinner /> Loading secure order…
            </div>
          )}
        </div>
      </>
    );

  const partnerPendingOrder = Boolean(order.partner && order.externalOrderId);
  const awaitingPartnerFinalization =
    partnerPendingOrder &&
    order.status === "REVIEW_PENDING" &&
    ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
      order.documentReviewStatus ?? "",
    );
  const displayedOrderStatus = awaitingPartnerFinalization
    ? "AWAITING_PARTNER_FINALIZATION"
    : order.purchaseType === "TOPUP" && order.status === "QR_READY"
      ? "PACKAGE_ADDED"
      : order.status;
  const canAdvanceOrder =
    order.status === "REVIEW_PENDING" && !partnerPendingOrder;
  const canReviewDocuments =
    !awaitingPartnerFinalization &&
    order.documentReviewPolicy !== "NO_REVIEW" &&
    ["DRAFT", "REVIEW_PENDING", "AWAITING_CUSTOMER"].includes(order.status) &&
    order.documents.length > 0;
  const canResendQr =
    order.purchaseType !== "TOPUP" &&
    ["QR_READY", "ACTIVATION_ATTENTION", "COMPLETED"].includes(order.status) &&
    Boolean(order.assignment?.inventoryId && order.assignment?.iccid);
  const requiredApproved = ["PASSPORT", "TICKET"].every((type) =>
    order.documents.some(
      (document) => document.type === type && document.status === "APPROVED",
    ),
  );
  const passportExpiry = order.traveler?.passportExpiryDate
    ? new Date(order.traveler.passportExpiryDate)
    : null;
  const orderedAt = new Date(order.createdAt);
  const passportValidWhenOrdered = Boolean(
    passportExpiry && passportExpiry > orderedAt,
  );
  const passportNearExpiryWhenOrdered = Boolean(
    passportExpiry &&
    passportValidWhenOrdered &&
    passportExpiry.getTime() - orderedAt.getTime() <= 180 * 24 * 60 * 60 * 1000,
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
      <Dialog
        open={!!previewDocument}
        onOpenChange={(open) => {
          if (!open && previewDocument) {
            URL.revokeObjectURL(previewDocument.url);
            setPreviewDocument(null);
          }
        }}
      >
        <DialogContent className="max-w-4xl" showCloseButton={false}>
          <DialogTitle className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate font-semibold">
                {previewDocument?.fileName}
              </p>
              <p className="text-xs font-normal text-muted-foreground">
                Secure preview · loaded directly for you
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

      <Dialog
        open={!!confirmAction}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.kind === "reject-documents"
                ? "Terminally reject documents"
                : "Cancel order"}
            </DialogTitle>
            <DialogDescription>
              This action cannot be undone and will be recorded in the order
              history. The pending partner order will remain uncharged. Please
              add a reason.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Reason (shown in the order history)
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
                if (confirmAction?.kind === "cancel")
                  action("cancel", { reason: confirmAction.reason.trim() });
                if (confirmAction?.kind === "reject-documents")
                  action("reject-documents", {
                    reason: confirmAction.reason.trim(),
                  });
                setConfirmAction(null);
              }}
            >
              {busy ? <Spinner /> : null}
              {confirmAction?.kind === "reject-documents"
                ? "Confirm terminal rejection"
                : "Confirm cancellation"}
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
        <h1 className="text-2xl font-semibold tracking-tight">
          {order.orderNumber}
        </h1>
        <StatusBadge
          label={displayedOrderStatus}
          tone={decisionTone(order.status)}
        />
        <Badge variant={order.purchaseType === "TOPUP" ? "info" : "secondary"}>
          {order.purchaseType === "TOPUP" ? humane("TOP-UP") : "First purchase"}
        </Badge>
      </div>
      <p className="-mt-4 mb-6 text-sm text-muted-foreground">
        {order.plan.name} · NPR {order.totalAmountNpr.toLocaleString()}
        {order.topUpMobile ? ` · top-up for ${order.topUpMobile}` : ""}
      </p>

      <ErrorDialog error={error} onClose={() => setError("")} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {order.purchaseType === "TOPUP" && (
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-primary" />
                  Top-up verification
                </span>
              }
            >
              <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
                The payment provider confirms payment before this plan is added
                to the customer&apos;s existing eSIM. The plan is then confirmed
                on the network profile automatically.
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                <InfoRow
                  label="Top-up mobile number"
                  value={
                    order.topUpMobile ??
                    order.assignment?.msisdn ??
                    "Unavailable"
                  }
                />
                <InfoRow
                  label="Payment status"
                  value={
                    order.payment?.status === "COMPLETED"
                      ? `Confirmed by ${order.payment?.provider === "FONEPAY" ? "Fonepay" : "Khalti"}`
                      : order.payment?.status
                        ? humane(order.payment.status)
                        : "Not started"
                  }
                />
                <InfoRow
                  label={`${order.payment?.provider === "FONEPAY" ? "Fonepay" : "Khalti"} payment ID`}
                  value={
                    order.payment?.providerTransactionId ??
                    order.payment?.reference ??
                    "Pending"
                  }
                />
                <InfoRow
                  label="Network confirmation"
                  value={
                    order.assignment?.verificationStatus
                      ? humane(order.assignment.verificationStatus)
                      : "Pending set-up"
                  }
                />
                <InfoRow
                  label="ICCID / SIM serial"
                  value={order.assignment?.iccid ?? "Assigned during set-up"}
                />
                <InfoRow
                  label="Provider subscription ID"
                  value={
                    order.assignment?.providerSubscriptionId ??
                    "Waiting for network"
                  }
                />
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
                <InfoRow
                  label="Date of birth"
                  value={order.traveler.dateOfBirth}
                />
                <InfoRow
                  label="Passport"
                  value={order.traveler.passportNumber}
                />
                <InfoRow
                  label="Passport expiry"
                  value={order.traveler.passportExpiryDate}
                />
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
              <p className="text-sm text-muted-foreground">
                Traveller details are incomplete for this order.
              </p>
            )}
          </Panel>

          <Panel
            title={
              <span className="flex items-center gap-2">
                <UserRound className="size-4 text-primary" />
                Customer identity
              </span>
            }
          >
            {order.customer ? (
              <div className="space-y-4">
                <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                  <InfoRow
                    label={
                      order.purchaseType === "TOPUP"
                        ? "Beneficiary / eSIM owner"
                        : "Customer"
                    }
                    value={`${order.customer.customerCode} · ${order.customer.email}`}
                  />
                  {order.purchaseType === "TOPUP" && (
                    <>
                      <InfoRow
                        label="Placed by"
                        value={
                          order.purchasedBy?.email ??
                          (order.partnerCustomer
                            ? `${order.partnerCustomer.externalCustomerId} via ${order.partnerCustomer.partner.name}`
                            : order.partner
                              ? order.partner.name
                              : "Guest")
                        }
                      />
                      <InfoRow
                        label="Target eSIM reference"
                        value={order.targetInventoryId ?? "Legacy assignment"}
                      />
                    </>
                  )}
                  <InfoRow
                    label="Order source"
                    value={orderSourceLabel(
                      order.channel,
                      Boolean(order.partner),
                    )}
                  />
                  <InfoRow
                    label="Customer signup source"
                    value={humane(order.customer.source)}
                  />
                  {order.partner && (
                    <InfoRow
                      label="Partner"
                      value={`${order.partner.name} · ${order.partner.code}`}
                    />
                  )}
                  <InfoRow
                    label="Login account"
                    value={
                      order.loginAccount
                        ? `${order.loginAccount.email} · ${humane(order.loginAccount.status)}`
                        : "Guest / no login account"
                    }
                  />
                  <InfoRow
                    label="Partner purchaser ID"
                    value={
                      order.partnerCustomer?.externalCustomerId ??
                      (order.partner
                        ? "Partner reference not recorded"
                        : "Not applicable")
                    }
                  />
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/customers/${order.customer.id}`}>
                      View customer
                    </Link>
                  </Button>
                  {order.loginAccount ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/users/${order.loginAccount.id}`}>
                        View login account
                      </Link>
                    </Button>
                  ) : null}
                  {(order.partnerCustomer?.partner ?? order.partner) ? (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={`/admin/partners/${(order.partnerCustomer?.partner ?? order.partner)!.id}`}
                      >
                        View partner
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Customer identity is unavailable.
              </p>
            )}
          </Panel>

          {partnerPendingOrder &&
          ["REVIEW_PENDING", "AWAITING_CUSTOMER"].includes(order.status) ? (
            <Button
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() =>
                setConfirmAction({
                  kind: "reject-documents",
                  reason: "",
                })
              }
            >
              <AlertTriangle className="size-4" />
              Terminally reject documents
            </Button>
          ) : null}

          <Panel
            title={
              <span className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-primary" />
                eSIM details
              </span>
            }
          >
            {order.assignment ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <StatusBadge
                    label={order.assignment.verificationStatus ?? "PENDING"}
                    tone={
                      order.assignment.verificationStatus === "VERIFIED"
                        ? "success"
                        : order.assignment.verificationStatus === "MISMATCH"
                          ? "danger"
                          : undefined
                    }
                  />
                  {order.traveler?.passportExpiryDate && (
                    <Badge
                      variant={
                        passportValidWhenOrdered
                          ? passportNearExpiryWhenOrdered
                            ? "warning"
                            : "success"
                          : "destructive"
                      }
                    >
                      {passportValidWhenOrdered
                        ? passportExpiry && passportExpiry <= new Date()
                          ? `Valid when ordered · expired ${passportExpiry.toLocaleDateString()}`
                          : passportNearExpiryWhenOrdered
                            ? `Near expiry · ${passportExpiry?.toLocaleDateString()}`
                            : "Passport valid"
                        : "Passport expired when ordered"}
                    </Badge>
                  )}
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                  <InfoRow
                    label="ICCID / SIM serial"
                    value={order.assignment.iccid ?? "—"}
                  />
                  <InfoRow
                    label="MSISDN"
                    value={order.assignment.msisdn ?? "—"}
                  />
                  <InfoRow
                    label="Provider subscription ID"
                    value={
                      order.assignment.providerSubscriptionId ??
                      "Waiting for network"
                    }
                  />
                  <InfoRow
                    label="Last network confirmation"
                    value={
                      order.assignment.providerLastSeenAt
                        ? new Date(
                            order.assignment.providerLastSeenAt,
                          ).toLocaleString()
                        : "Pending"
                    }
                  />
                </dl>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                    <InfoRow
                      label="Fulfillment"
                      value={
                        order.purchaseType === "TOPUP"
                          ? "Package added to existing eSIM"
                          : "QR delivered"
                      }
                    />
                    <InfoRow
                      label="Customer installation"
                      value={
                        order.purchaseType === "TOPUP"
                          ? "Not required — existing eSIM"
                          : providerCheck?.classification === "ACTIVE" ||
                              order.status === "COMPLETED"
                            ? "Activated"
                            : "Awaiting first use"
                      }
                    />
                    <InfoRow
                      label="Provider profile"
                      value={providerCheck?.profileStatus ?? "Not checked"}
                    />
                    <InfoRow
                      label="Network subscriber"
                      value={
                        providerCheck?.subscriberStatus ??
                        order.providerStatus ??
                        "Not checked"
                      }
                    />
                    <InfoRow
                      label="Data subscription"
                      value={providerCheck?.subscriptionStatus ?? "Not checked"}
                    />
                    {order.purchaseType !== "TOPUP" ? (
                      <InfoRow
                        label="Last successful QR delivery"
                        value={
                          order.qrDelivery?.lastSuccessfulAt
                            ? new Date(
                                order.qrDelivery.lastSuccessfulAt,
                              ).toLocaleString()
                            : order.qrDelivery?.pending
                              ? "Delivery queued"
                              : "No successful delivery recorded"
                        }
                      />
                    ) : null}
                  </dl>
                  {providerCheck ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {providerCheck.recommendedAction} Checked{" "}
                      {new Date(providerCheck.checkedAt).toLocaleString()}.
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Package usage · this order
                    </p>
                    <p className="mt-2 text-2xl font-semibold tabular-nums">
                      {order.packageUsage?.balanceStatus ===
                      "WAITING_FOR_FIRST_USE"
                        ? "Awaiting activation"
                        : order.packageUsage?.balanceStatus === "UNAVAILABLE"
                          ? "Balance unavailable"
                          : order.packageUsage
                            ? `${order.packageUsage.remainingMb.toLocaleString()} MB`
                            : "Not confirmed"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {order.packageUsage?.balanceStatus ===
                      "WAITING_FOR_FIRST_USE"
                        ? order.purchaseType === "TOPUP"
                          ? "Package added to the existing eSIM. Balance appears after activation."
                          : "Your first package is ready. Balance appears after the eSIM connects to a supported network."
                        : order.packageUsage?.balanceStatus === "UNAVAILABLE"
                          ? "The provider has not confirmed a usable balance."
                          : order.packageUsage
                            ? `${order.packageUsage.usedMb.toLocaleString()} MB used of ${order.packageUsage.totalMb.toLocaleString()} MB · ${humane(order.packageUsage.balanceStatus)}`
                            : "Usage will appear after provider reconciliation."}
                    </p>
                  </div>
                  <div className="rounded-lg border p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Physical eSIM overview
                    </p>
                    <p className="mt-2 text-2xl font-semibold tabular-nums">
                      {order.esimUsage &&
                      order.esimUsage.summary.confirmedPackageCount > 0
                        ? `${order.esimUsage.summary.remainingMb.toLocaleString()} MB`
                        : "Balance not confirmed"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {order.esimUsage
                        ? `${order.esimUsage.summary.confirmedPackageCount} of ${order.esimUsage.summary.packageCount} packages confirmed · ${humane(order.esimUsage.freshness)}`
                        : "Aggregate usage is not available."}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  disabled={busy === "usage-refresh"}
                  onClick={() => void refreshUsage()}
                  title="Fetch the latest remaining data balance for this eSIM and its packages"
                >
                  {busy === "usage-refresh" ? (
                    <Spinner />
                  ) : (
                    <RefreshCcw className="size-4" />
                  )}
                  Refresh data balance
                </Button>
                <Button
                  variant="outline"
                  disabled={busy === "provider-status-check"}
                  onClick={() => void checkProvider()}
                  title="Read the latest eSIM and subscription status from Transatel without changing service"
                >
                  {busy === "provider-status-check" ? (
                    <Spinner />
                  ) : (
                    <RefreshCcw className="size-4" />
                  )}
                  Refresh network status
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This plan has not been linked to an eSIM yet.
              </p>
            )}
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
                className="flex flex-col items-stretch gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="whitespace-nowrap font-medium">
                    {humane(document.type)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {document.fileName}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                  <StatusBadge
                    label={documentReviewLabel(
                      document,
                      order.passportVerification?.status,
                    )}
                    tone={
                      documentReviewLabel(
                        document,
                        order.passportVerification?.status,
                      ) === "Verified automatically"
                        ? "success"
                        : undefined
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => preview(document.id)}
                  >
                    Preview
                  </Button>
                  {canReviewDocuments && document.status !== "APPROVED" && (
                    <Button
                      size="sm"
                      variant="success"
                      disabled={Boolean(busy)}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Approve ${humane(document.type)} document?`,
                            description:
                              "This audited manual decision overrides the OCR result.",
                            confirmLabel: "Approve document",
                          })
                        )
                          void action(`documents/${document.id}/approve`);
                      }}
                    >
                      {busy === `documents/${document.id}/approve` ? (
                        <Spinner className="text-success-foreground" />
                      ) : (
                        <CheckCircle2 className="size-4" />
                      )}
                      Approve
                    </Button>
                  )}
                  {canReviewDocuments &&
                    document.type !== "VISA" &&
                    document.status !== "APPROVED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: "Request a new document?",
                              description:
                                "The reason entered below will be shared with the customer.",
                              confirmLabel: "Request re-upload",
                            })
                          )
                            void action(
                              `documents/${document.id}/request-reupload`,
                              {
                                reason,
                              },
                            );
                        }}
                      >
                        <RefreshCcw className="size-4" />
                        Re-upload
                      </Button>
                    )}
                </div>
              </div>
            ))}
          </Panel>

          <Panel title="Order history">
            <ol className="relative ml-2 space-y-6 border-l border-border pl-6">
              {[...order.timeline].reverse().map((event, index) => (
                <li key={`${event.at}-${index}`} className="relative">
                  <span className="absolute top-1 -left-[30px] flex size-2.5 items-center justify-center">
                    <span className="absolute size-2.5 rounded-full bg-border" />
                    <span className="relative size-1.5 rounded-full bg-primary" />
                  </span>
                  <p className="text-sm font-medium">
                    {humane(
                      awaitingPartnerFinalization &&
                        event.to === "REVIEW_PENDING"
                        ? "AWAITING_PARTNER_FINALIZATION"
                        : orderEventLabel(event),
                    )}
                  </p>
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
              Payment provider: {humane(order.payment?.provider ?? "—")}
            </p>
            <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">
                Checkout verification
              </span>
              <StatusBadge
                label={
                  order.purchaseType === "TOPUP"
                    ? "NOT REQUIRED"
                    : (order.documentReviewStatus ?? "NOT STARTED")
                }
              />
            </div>
            {order.documentReviewStatus === "VERIFIED" && (
              <p className="text-xs text-muted-foreground">
                Passport verification passed. This is separate from manual
                review of the individual attachments below.
              </p>
            )}
            {canReviewDocuments &&
              !canAdvanceOrder &&
              order.documents.some(
                (document) => document.status !== "APPROVED",
              ) && (
                <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <p className="text-xs text-muted-foreground">
                    Manual attachment review is available. Passport OCR does not
                    approve the ticket or visa. Any decision here updates the
                    attachment record and does not reverse payment or
                    activation.
                  </p>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Reason for a re-upload request
                    </Label>
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={3}
                      className="w-full rounded-md border border-input bg-transparent p-3 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2"
                    />
                  </div>
                  <p className="text-xs font-medium">
                    Use Approve or Re-upload beside each document.
                  </p>
                </div>
              )}
            {canAdvanceOrder ? (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Reason to share with the customer
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
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Approve and activate this order?",
                        description:
                          "This submits the eSIM set-up to the network and cannot be undone.",
                        confirmLabel: "Approve and start set-up",
                      })
                    )
                      void action("approve");
                  }}
                >
                  {busy === "approve" ? (
                    <Spinner className="text-success-foreground" />
                  ) : (
                    <ShieldCheck className="size-4" />
                  )}
                  {requiredApproved
                    ? "Approve and start set-up"
                    : "Approve passport and ticket first"}
                </Button>
              </>
            ) : order.status === "PROVISIONING_FAILED" ? (
              <div className="space-y-2">
                <Button className="w-full" variant="outline" size="lg" asChild>
                  <Link href="/provisioning-operations">
                    <RefreshCcw className="size-4" />
                    Check set-up recovery
                  </Link>
                </Button>
                {isSuperAdmin ? (
                  <Button
                    className="w-full"
                    variant="success"
                    size="lg"
                    disabled={Boolean(busy)}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: "Retry eSIM set-up?",
                          description:
                            "Proceed only after confirming the network did not already accept the order, to avoid a duplicate activation.",
                          confirmLabel: "Retry set-up",
                          destructive: true,
                        })
                      )
                        void action("retry");
                    }}
                  >
                    {busy === "retry" ? (
                      <Spinner className="text-success-foreground" />
                    ) : (
                      <RefreshCcw className="size-4" />
                    )}
                    Try set-up again
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    A Super Admin must approve any retry or replacement.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  If the network may have already accepted the order, check
                  set-up recovery first to avoid a duplicate.
                </p>
              </div>
            ) : canResendQr ? (
              <Button
                className="w-full"
                variant="outline"
                size="lg"
                disabled={Boolean(busy)}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Resend installation QR?",
                      description:
                        "The customer will receive another installation email for this eSIM.",
                      confirmLabel: "Resend QR",
                    })
                  )
                    void action("resend-qr");
                }}
              >
                {busy === "resend-qr" ? (
                  <Spinner />
                ) : (
                  <QrCode className="size-4" />
                )}
                Resend installation QR
              </Button>
            ) : ["QR_READY", "ACTIVATION_ATTENTION", "COMPLETED"].includes(
                order.status,
              ) ? (
              <Button className="w-full" variant="outline" size="lg" asChild>
                <Link href="/provisioning-operations">
                  <RefreshCcw className="size-4" />
                  {order.purchaseType === "TOPUP"
                    ? "Reconcile recharge assignment"
                    : "Reconcile QR assignment"}
                </Link>
              </Button>
            ) : order.status === "PAYMENT_REVIEW_REQUIRED" ? (
              <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <p>
                    Payment has not been confirmed. The payment evidence
                    requires operational review.
                  </p>
                </div>
                <Button className="w-full" variant="outline" size="sm" asChild>
                  <Link href="/attention">Open attention queue</Link>
                </Button>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                No action needed from you for this order.
              </div>
            )}
            <ManualRefundCard
              orderId={order.id}
              {...(order.payment?.provider
                ? { paymentProvider: order.payment.provider }
                : {})}
              hasPaymentAttempt={Boolean(order.payment)}
              alreadyRefunded={
                order.payment?.status === "REFUNDED" ||
                order.status === "REFUNDED"
              }
            />
            {["DRAFT", "PAYMENT_PENDING", "PAYMENT_FAILED"].includes(
              order.status,
            ) && (
              <Button
                className="w-full text-destructive hover:bg-destructive/10"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() =>
                  setConfirmAction({
                    kind: "cancel",
                    reason: "Customer request",
                  })
                }
              >
                <AlertTriangle className="size-4" />
                Cancel order
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Every decision and change is saved to the order history for your
              records.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
