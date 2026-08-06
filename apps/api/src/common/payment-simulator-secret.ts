/**
 * Shared resolution of the payment webhook signing secret.
 *
 * A well-known placeholder value is only ever used in non-production builds so
 * that local/sandbox flows stay easy to exercise. In production the secret must
 * be explicitly configured: falling back to a public constant would let anyone
 * forge `x-visa-signature` webhook headers.
 */
export function paymentSimulatorSecret(): string {
  const secret = process.env.PAYMENT_SIMULATOR_SECRET;
  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error("PAYMENT_SIMULATOR_SECRET is required in production");
  }
  return secret || "local-development-only-change-me";
}