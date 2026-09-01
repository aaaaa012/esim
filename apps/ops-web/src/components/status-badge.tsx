import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export type StatusTone =
  "default" | "success" | "warning" | "danger" | "info" | "destructive";

type StatusBadgeProps = {
  label: string;
  tone?: StatusTone | undefined;
  className?: string;
  children?: ReactNode;
};

const toneMap: Record<
  string,
  "success" | "warning" | "danger" | "info" | "destructive"
> = {
  success: "success",
  green: "success",
  healthy: "success",
  up: "success",
  sent: "success",
  approved: "success",
  processed: "success",
  completed: "success",
  active: "success",
  activated: "success",
  available: "success",
  verified: "success",
  operational: "success",
  qr_ready: "info",
  warning: "warning",
  pending: "warning",
  queued: "warning",
  review_pending: "warning",
  awaiting_customer: "warning",
  provisioning_failed: "danger",
  expired: "warning",
  suspended: "warning",
  degraded: "warning",
  suspend_pending: "warning",
  termination_pending: "danger",
  terminated: "danger",
  cancelled: "warning",
  refunded: "success",
  down: "danger",
  action_required: "danger",
  failed: "danger",
  rejected: "danger",
  red: "danger",
  danger: "danger",
  draft: "info",
  reserved: "info",
  assigned: "info",
  quarantined: "destructive",
};

// Human-readable labels for internal status/reason codes shown on every page.
const labelMap: Record<string, string> = {
  DRAFT: "Draft",
  PAYMENT_PENDING: "Payment pending",
  PAYMENT_CONFIRMED: "Payment confirmed",
  PAYMENT_FAILED: "Payment failed",
  PAYMENT_REVIEW_REQUIRED: "Payment needs confirmation",
  REVIEW_PENDING: "Awaiting review",
  AWAITING_PARTNER_FINALIZATION: "Awaiting partner finalization",
  AWAITING_CUSTOMER: "Awaiting customer",
  APPROVED: "Approved",
  PROVISIONING: "Setting up",
  QR_READY: "Ready to install",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  PROVISIONING_FAILED: "Set-up failed",
  ACTIVATION_ATTENTION: "Activation needs attention",
  SETUP_FAILED: "Set-up failed",
  REFUND_PENDING: "Refund pending",
  REFUNDED: "Refunded",
  PENDING: "Pending",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  EXPIRED: "Expired",
  TERMINATED: "Terminated",
  FAILED: "Failed",
  AVAILABLE: "Available",
  IMPORTED: "Imported",
  RESERVED: "Reserved",
  ASSIGNED: "Assigned",
  ACTIVATED: "Activated",
  QUARANTINED: "Quarantined",
  NOT_CHECKED: "Not checked",
  SUSPEND_PENDING: "Suspension in progress",
  TERMINATION_PENDING: "Termination in progress",
  ACCEPTED: "Accepted",
  WAITING_FOR_QR: "Waiting for QR",
  RECONCILE_REQUIRED: "Needs checking",
  MANUAL_REVIEW: "Needs manual review",
  REQUESTED: "Requested",
  REJECTED: "Rejected",
  VERIFIED: "Verified",
  LOOKUP_VERIFIED: "Verified — awaiting final confirmation",
  PROCESSED: "Processed",
  QUEUED: "Queued",
  UP: "Online",
  DEGRADED: "Degraded",
  DOWN: "Down",
  OPERATIONAL: "All good",
  ACTION_REQUIRED: "Needs attention",
  TOP_UP: "Top-up",
  TOPUP: "Top-up",
  TOP_UP_ORDER: "Top-up",
  FIRST_PURCHASE: "First purchase",
  INITIAL_PURCHASE: "First purchase",
  NEW_PURCHASE: "First purchase",
  PROVISIONING_FAILURE: "We couldn’t set up the service",
  INCORRECT_FULFILLMENT: "Customer got the wrong plan",
  DUPLICATE_CHARGE: "Customer was charged twice",
  PROVIDER_SERVICE_FAILURE: "Network provider issue",
  INTERNAL_OPERATIONAL_ERROR: "Our internal error",
  INTEGRATION_FAILED: "Integration failed",
  SIGNATURE_VALID: "Verified",
  SIGNATURE_INVALID: "Signature invalid",
  CUSTOMER_WEB: "Customer web",
  PARTNER_API: "Partner API",
  PARTNER_HOSTED: "Checkout link",
  DIRECT: "Direct customer",
  PARTNER: "Partner",
  TRANSATEL: "Transatel",
  KHALTI: "Khalti",
  ORDER: "Order",
  PAYMENT: "Payment",
  INTEGRATION: "Integration",
  NOTIFICATION: "Notification",
  INVENTORY: "Inventory",
  PLANS: "Plans",
  PROVISIONING_REQUIRED: "Set-up required",
  ACTIVATION_PENDING: "Awaiting activation",
  CONFIG_REQUIRED: "Needs configuration",
  NOT_STARTED: "Not started",
  PASSPORT: "Passport",
  TICKET: "Ticket",
  VISA: "Visa",
  IDENTITY: "Identity document",
  ID_CARD: "ID card",
  FLIGHT_ITINERARY: "Flight itinerary",
  OTHER: "Other document",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  ORDER_QR_READY: "Installation QR sent",
  PLAN_EXPIRED: "Plan expired",
  PLAN_EXHAUSTED: "Data finished",
  PAYMENT_RECEIPT: "Payment receipt",
  PAYMENT_CONFIRMED_EMAIL: "Payment confirmed",
  DOCUMENT_REQUESTED: "Documents requested",
  WELCOME: "Welcome message",
  OPERATIONS: "Operations team",
  SUPER_ADMIN: "Super admin",
  CUSTOMER: "Customer",
};

const dotMap: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  destructive: "bg-red-500",
  info: "bg-sky-500",
  default: "bg-muted-foreground/60",
};

function toneFor(label: string, tone?: StatusTone): StatusTone {
  if (tone) return tone;
  return toneMap[normalize(label)] ?? "default";
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function displayLabel(label: string) {
  const key = label.trim().toUpperCase().replace(/\s+/g, "_");
  return labelMap[key] ?? label.replaceAll("_", " ");
}

/** Plain-text human-readable version of an internal status/reason code. */
export function humane(label: string | null | undefined): string {
  return displayLabel(label == null ? "" : String(label));
}

export function StatusBadge({
  label,
  tone,
  className,
  children,
}: StatusBadgeProps) {
  const text = label == null ? "" : String(label);
  const resolved = toneFor(text, tone);
  return (
    <Badge
      variant={
        resolved === "success"
          ? "success"
          : resolved === "warning"
            ? "warning"
            : resolved === "danger"
              ? "destructive"
              : resolved === "info"
                ? "info"
                : "secondary"
      }
      className={cn("gap-1.5 pl-2", className)}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", dotMap[resolved])}
      />
      {children}
      {displayLabel(text)}
    </Badge>
  );
}
