const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

/**
 * Production defaults for remote dependencies. Mutating provider requests are
 * not blindly retried here because an accepted request can time out locally;
 * durable reconciliation performs the safe retry after checking provider
 * evidence. Environment overrides are deliberately bounded.
 */
export const resiliencePolicy = {
  paymentTimeoutMs: () =>
    boundedInteger(
      process.env.KHALTI_REQUEST_TIMEOUT_MS ??
        process.env.PAYMENT_REQUEST_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
    ),
  fonepayTimeoutMs: () =>
    boundedInteger(
      process.env.FONEPAY_REQUEST_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
    ),
  connectivityTimeoutMs: () =>
    boundedInteger(
      process.env.TRANSATEL_REQUEST_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
    ),
  partnerWebhookTimeoutMs: () =>
    boundedInteger(
      process.env.PARTNER_WEBHOOK_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
    ),
  connectivityCircuitFailures: () =>
    boundedInteger(process.env.TRANSATEL_CIRCUIT_FAILURE_THRESHOLD, 5, 2, 20),
  connectivityCircuitResetMs: () =>
    boundedInteger(
      process.env.TRANSATEL_CIRCUIT_RESET_MS,
      30_000,
      5_000,
      300_000,
    ),
} as const;

export const PARTNER_WEBHOOK_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential" as const, delay: 30_000 },
  jitter: 0.25,
} as const;

export const INBOUND_WEBHOOK_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential" as const, delay: 30_000 },
  jitter: 0.25,
} as const;

export const NOTIFICATION_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: "exponential" as const, delay: 15_000 },
  jitter: 0.25,
} as const;
