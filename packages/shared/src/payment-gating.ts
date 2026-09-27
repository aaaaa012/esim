import { OrderStatus, PaymentStatus } from "./contracts.js";

/**
 * Server-declared authorization to start a *new* payment attempt (or switch
 * provider) for an order.
 *
 * Retry/change-provider actions are only safe when the server proves no charge
 * is uncertain. A payment window that is still open, an expired-but-unresolved
 * session, or an order under PAYMENT_REVIEW_REQUIRED all mean a charge may
 * still be captured, so a fresh attempt must be blocked and resolved by the
 * reconciliation worker first. Every customer-facing surface reads this
 * declaration rather than inferring safety from provider-looking state.
 */
export type PaymentRetryDeclaration = {
  canRetry: boolean;
  canChangeProvider: boolean;
  /** Customer-safe reason when retry/change is not currently permitted. */
  blockedReason?: string;
};

export type RetryDeclarationInput = {
  status: string;
  payment?:
    | {
        status?: string;
        expiresAt?: string;
      }
    | null
    | undefined;
  now?: number;
};

const SESSION_ACTIVE_REASON =
  "We are still confirming your current payment. Please check the status before starting another one.";
const RECONCILING_REASON =
  "We are confirming whether your previous attempt was charged before allowing a new payment.";
const REVIEW_REQUIRED_REASON =
  "Your previous payment could not be confirmed automatically. Our team must check it before a new attempt is safe.";
const FULFILLMENT_REASON =
  "This order is already being fulfilled. Starting another payment is not allowed.";

/**
 * Provider-neutral retry authorization. The caller (API) embeds the result in
 * every customer order view; customer clients trust it instead of inspecting
 * raw provider state.
 */
export function declarePaymentRetry(
  input: RetryDeclarationInput,
): PaymentRetryDeclaration {
  const now = input.now ?? Date.now();
  const status = input.status;
  const payment = input.payment;

  if (
    status === OrderStatus.PAYMENT_REVIEW_REQUIRED ||
    payment?.status === PaymentStatus.REVIEW_REQUIRED
  )
    return {
      canRetry: false,
      canChangeProvider: false,
      blockedReason: REVIEW_REQUIRED_REASON,
    };

  // Payment evidence outranks a stale or contradictory order status. This
  // prevents a partially persisted DRAFT/PAYMENT_FAILED order from advertising
  // a retry while an earlier provider session can still charge.
  if (
    payment?.status === PaymentStatus.PENDING ||
    payment?.status === PaymentStatus.INITIATED
  ) {
    const activeSession = Boolean(
      payment.expiresAt && new Date(payment.expiresAt).getTime() > now,
    );
    return {
      canRetry: false,
      canChangeProvider: false,
      blockedReason: activeSession ? SESSION_ACTIVE_REASON : RECONCILING_REASON,
    };
  }

  if (
    payment?.status === PaymentStatus.COMPLETED ||
    payment?.status === PaymentStatus.REFUNDED
  )
    return {
      canRetry: false,
      canChangeProvider: false,
      blockedReason:
        payment.status === PaymentStatus.REFUNDED
          ? REVIEW_REQUIRED_REASON
          : FULFILLMENT_REASON,
    };

  if (status === OrderStatus.PAYMENT_PENDING) {
    return { canRetry: false, canChangeProvider: false };
  }

  if (status === OrderStatus.DRAFT || status === OrderStatus.PAYMENT_FAILED)
    return { canRetry: true, canChangeProvider: true };

  if (
    status === OrderStatus.CANCELLED ||
    status === OrderStatus.REFUNDED ||
    status === OrderStatus.REFUND_PENDING
  )
    return {
      canRetry: false,
      canChangeProvider: false,
      blockedReason: "This order is closed and cannot be paid again.",
    };

  return {
    canRetry: false,
    canChangeProvider: false,
    blockedReason: FULFILLMENT_REASON,
  };
}
