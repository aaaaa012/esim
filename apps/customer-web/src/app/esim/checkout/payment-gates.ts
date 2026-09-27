export function paymentActionDisabled(input: {
  isTopUp: boolean;
  verifyingPassport: boolean;
  passportGatePassed: boolean;
  retryAllowed?: boolean;
}) {
  return (
    input.verifyingPassport ||
    (!input.isTopUp && !input.passportGatePassed) ||
    input.retryAllowed === false
  );
}

/**
 * The checkout never decides on its own whether a retry or a provider switch
 * is safe: it renders exactly what the server declared. When the declaration
 * is missing the control is allowed (the server rejects with
 * PAYMENT_RETRY_NOT_SAFE if it disagrees); when it is explicitly blocked the
 * UI disables the action so the customer cannot start a second payment whose
 * charge is uncertain.
 */
export function retryDeclaredAllowed(
  declaration: {
    canRetry?: boolean;
    canChangeProvider?: boolean;
  } | null | undefined,
  field: "canRetry" | "canChangeProvider",
) {
  if (!declaration) return true;
  return declaration[field] ?? true;
}