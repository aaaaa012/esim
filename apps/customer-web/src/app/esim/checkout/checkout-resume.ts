export type CheckoutResumeDisposition =
  "EDITABLE" | "POST_PAYMENT" | "UNSUPPORTED";

const EDITABLE_STATUSES = new Set([
  "DRAFT",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "PAYMENT_REVIEW_REQUIRED",
]);

const POST_PAYMENT_STATUSES = new Set([
  "PAYMENT_CONFIRMED",
  "REVIEW_PENDING",
  "APPROVED",
  "PROVISIONING",
  "QR_READY",
  "ACTIVATION_ATTENTION",
  "COMPLETED",
  "PROVISIONING_FAILED",
  "CANCELLED",
  "REFUND_PENDING",
  "REFUNDED",
]);

export function checkoutResumeDisposition(
  status: string,
): CheckoutResumeDisposition {
  if (EDITABLE_STATUSES.has(status)) return "EDITABLE";
  if (POST_PAYMENT_STATUSES.has(status)) return "POST_PAYMENT";
  return "UNSUPPORTED";
}

export type CheckoutOrderSnapshot = {
  status: string;
  purchaseType?: string;
  traveler?: unknown;
  documents?: { type: string; uploadVerified?: boolean }[];
  documentReviewStatus?: string;
  payment?: { reference?: string; status?: string };
};

const DOCUMENT_GATE_PASSED = new Set([
  "VERIFIED",
  "MANUALLY_APPROVED",
  "SKIPPED",
]);

export function checkoutResumeStep(order: CheckoutOrderSnapshot): number {
  if (
    checkoutResumeDisposition(order.status) === "POST_PAYMENT" ||
    order.purchaseType === "TOPUP" ||
    order.payment?.status === "PENDING" ||
    order.status === "PAYMENT_PENDING" ||
    order.status === "PAYMENT_FAILED"
  )
    return 4;

  if (!order.traveler) return 2;

  const hasRequiredDocuments = ["PASSPORT", "TICKET"].every((type) =>
    order.documents?.some(
      (document) => document.type === type && document.uploadVerified,
    ),
  );

  return hasRequiredDocuments &&
    DOCUMENT_GATE_PASSED.has(order.documentReviewStatus ?? "")
    ? 4
    : 3;
}

export function paymentStatusHeading(provider?: string): string {
  if (provider === "FONEPAY") return "Checking Fonepay payment status";
  if (provider === "KHALTI") return "Checking Khalti payment status";
  return "Checking payment status";
}
