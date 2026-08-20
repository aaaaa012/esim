/**
 * Public API error codes.
 *
 * Codes are stable, machine-readable identifiers that clients can rely on to
 * render user-friendly copy. Messages in responses are always safe for the
 * end user — internal detail (provider responses, stack traces, identifiers)
 * is never included in the client payload.
 */
export const ApiErrorCode = {
  // Generic / transport
  UNEXPECTED: "UNEXPECTED",
  RATE_LIMITED: "RATE_LIMITED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",

  // Validation
  VALIDATION_ERROR: "VALIDATION_ERROR",

  // Authentication & authorization
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  ACCOUNT_SYNCHRONIZATION_FAILED: "ACCOUNT_SYNCHRONIZATION_FAILED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  ACCOUNT_TYPE_FORBIDDEN: "ACCOUNT_TYPE_FORBIDDEN",
  MFA_REQUIRED: "MFA_REQUIRED",
  INTEGRATION_TYPE_FORBIDDEN: "INTEGRATION_TYPE_FORBIDDEN",

  // Catalog & plans
  PLAN_NOT_AVAILABLE: "PLAN_NOT_AVAILABLE",
  COVERAGE_UNAVAILABLE: "COVERAGE_UNAVAILABLE",
  PLAN_UNAVAILABLE: "PLAN_UNAVAILABLE",
  DOCUMENT_REQUIRED: "DOCUMENT_REQUIRED",
  PASSPORT_REQUIRED: "PASSPORT_REQUIRED",
  INSUFFICIENT_PARTNER_BALANCE: "INSUFFICIENT_PARTNER_BALANCE",
  TOPUP_UNAVAILABLE: "TOPUP_UNAVAILABLE",

  // Orders
  ORDER_INVALID_STATE: "ORDER_INVALID_STATE",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_IMMUTABLE: "ORDER_IMMUTABLE",
  COMPATIBILITY_REQUIRED: "COMPATIBILITY_REQUIRED",
  TRAVELER_REQUIRED: "TRAVELER_REQUIRED",
  DOCUMENTS_REQUIRED: "DOCUMENTS_REQUIRED",
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
  DOCUMENT_STORAGE_UNAVAILABLE: "DOCUMENT_STORAGE_UNAVAILABLE",
  PASSPORT_VERIFICATION_REQUIRED: "PASSPORT_VERIFICATION_REQUIRED",
  PASSPORT_VERIFICATION_FAILED: "PASSPORT_VERIFICATION_FAILED",

  // Payments
  PAYMENT_PROVIDER_ERROR: "PAYMENT_PROVIDER_ERROR",
  PAYMENT_NOT_CONFIRMED: "PAYMENT_NOT_CONFIRMED",
  PAYMENT_REFERENCE_MISMATCH: "PAYMENT_REFERENCE_MISMATCH",
  PAYMENT_EXPIRED: "PAYMENT_EXPIRED",

  // Connectivity (Transatel)
  CONNECTIVITY_CONFIGURATION: "CONNECTIVITY_CONFIGURATION",
  CONNECTIVITY_UNAVAILABLE: "CONNECTIVITY_UNAVAILABLE",
  ELIGIBILITY_REJECTED: "ELIGIBILITY_REJECTED",
  PRODUCT_UNAVAILABLE: "PRODUCT_UNAVAILABLE",
  PROVISIONING_FAILED: "PROVISIONING_FAILED",
  PROVISIONING_DELAYED: "PROVISIONING_DELAYED",
  INVENTORY_UNAVAILABLE: "INVENTORY_UNAVAILABLE",
  INVENTORY_IMPORT_INVALID: "INVENTORY_IMPORT_INVALID",
  USAGE_UNAVAILABLE: "USAGE_UNAVAILABLE",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** Maps an API error code to the message customers should see. */
export const apiErrorMessage = (
  code: string,
  fallback = "Something went wrong. Please try again.",
): string => {
  switch (code) {
    case ApiErrorCode.VALIDATION_ERROR:
      return "Please check your details and try again.";
    case ApiErrorCode.RATE_LIMITED:
      return "Too many attempts. Please wait a moment and try again.";
    case ApiErrorCode.AUTHENTICATION_REQUIRED:
      return "Please sign in to continue.";
    case ApiErrorCode.ACCOUNT_DISABLED:
      return "Your account is currently disabled. Contact support for help.";
    case ApiErrorCode.ACCOUNT_TYPE_FORBIDDEN:
      return "You do not have permission to perform this action.";
    case ApiErrorCode.INTEGRATION_TYPE_FORBIDDEN:
      return "This partner is not approved for hosted checkout links.";
    case ApiErrorCode.MFA_REQUIRED:
      return "Additional verification is required to continue.";
    case ApiErrorCode.PLAN_NOT_AVAILABLE:
      return "This plan is no longer available. Please choose another plan.";
    case ApiErrorCode.PLAN_UNAVAILABLE:
      return "This plan is unavailable right now. Please choose another plan.";
    case ApiErrorCode.COVERAGE_UNAVAILABLE:
      return "Coverage is unavailable for this destination right now. Please contact support.";
    case ApiErrorCode.ORDER_NOT_FOUND:
      return "We could not find this order. It may have expired.";
    case ApiErrorCode.ORDER_INVALID_STATE:
      return "This order cannot be changed in its current state.";
    case ApiErrorCode.COMPATIBILITY_REQUIRED:
      return "Please confirm your device is eSIM-compatible to continue.";
    case ApiErrorCode.TRAVELER_REQUIRED:
      return "Traveller details are required before payment.";
    case ApiErrorCode.DOCUMENTS_REQUIRED:
      return "Passport and travel ticket are required before payment.";
    case ApiErrorCode.DOCUMENT_REQUIRED:
      return "This document is required before payment.";
    case ApiErrorCode.PASSPORT_REQUIRED:
      return "A passport is required before payment.";
    case ApiErrorCode.DOCUMENT_STORAGE_UNAVAILABLE:
      return "Secure document upload is temporarily unavailable. Please try again.";
    case ApiErrorCode.PASSPORT_VERIFICATION_REQUIRED:
      return "We need to verify your passport against your traveller details before payment.";
    case ApiErrorCode.PASSPORT_VERIFICATION_FAILED:
      return "We could not verify your passport. Make sure the details match your passport exactly, then try again.";
    case ApiErrorCode.PAYMENT_PROVIDER_ERROR:
      return "The payment provider is temporarily unavailable. Please try again or use another method.";
    case ApiErrorCode.PAYMENT_NOT_CONFIRMED:
      return "We could not confirm your payment. Please verify with your wallet or retry.";
    case ApiErrorCode.PAYMENT_REFERENCE_MISMATCH:
      return "The payment reference does not match this order.";
    case ApiErrorCode.PAYMENT_EXPIRED:
      return "This payment attempt has expired. Please start a new one.";
    case ApiErrorCode.CONNECTIVITY_UNAVAILABLE:
      return "Our connectivity provider is temporarily unavailable. Please try again shortly.";
    case ApiErrorCode.ELIGIBILITY_REJECTED:
      return "This eSIM is not available for the number you provided. Please check and try again.";
    case ApiErrorCode.PRODUCT_UNAVAILABLE:
      return "This plan is no longer offered by our provider. Please choose another plan.";
    case ApiErrorCode.PROVISIONING_FAILED:
      return "We could not activate your eSIM right now. Our team is reviewing it and will contact you.";
    case ApiErrorCode.INVENTORY_UNAVAILABLE:
      return "No eSIM is available right now. Please try again shortly.";
    case ApiErrorCode.INSUFFICIENT_PARTNER_BALANCE:
      return "The partner account balance is insufficient. Please top up the partner account.";
    case ApiErrorCode.TOPUP_UNAVAILABLE:
      return "No active eSIM was found for that number. It will be processed as a new purchase.";
    case ApiErrorCode.USAGE_UNAVAILABLE:
      return "Usage details are not available yet. Please check back shortly.";
    default:
      return fallback;
  }
};

/**
 * Customer-facing reasons an eSIM activation can fail on. Each code maps to a
 * safe message customers can act on. Internal/provider detail is never
 * serialized to clients; it stays in the order's timeline and ops views.
 */
export const ProvisioningFailureCode = {
  INVENTORY_UNAVAILABLE: "INVENTORY_UNAVAILABLE",
  PLAN_UNAVAILABLE: "PLAN_UNAVAILABLE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
} as const;
export type ProvisioningFailureCode =
  (typeof ProvisioningFailureCode)[keyof typeof ProvisioningFailureCode];

export type ProvisioningFailure = {
  code: ProvisioningFailureCode;
  message: string;
};

/** Builds a customer-safe activation-failure result for a given code. */
export const provisioningFailure = (
  code: ProvisioningFailureCode,
): ProvisioningFailure => {
  const messages: Record<ProvisioningFailureCode, string> = {
    INVENTORY_UNAVAILABLE:
      "We are out of stock for this plan right now. You have not been charged.",
    PLAN_UNAVAILABLE:
      "This plan is no longer offered. Please choose another plan.",
    PROVIDER_UNAVAILABLE:
      "We could not activate your eSIM right now. Our team is reviewing it and will contact you.",
    UNKNOWN:
      "We could not activate your eSIM right now. Our team is reviewing it and will contact you.",
  };
  return { code, message: messages[code] };
};
