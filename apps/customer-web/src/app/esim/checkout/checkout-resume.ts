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
