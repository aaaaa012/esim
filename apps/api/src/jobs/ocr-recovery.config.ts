import { createHash } from "node:crypto";

export type OcrRecoveryConfig = {
  graceMs: number;
  retryDelayMs: number;
  attempts: number;
  sweepMs: number;
};

const positiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * OCR is allowed a short recovery window before a technical outage becomes a
 * manual-review case. The independent workflow reconciler enforces the same
 * deadline when the OCR process is completely offline and therefore cannot
 * exhaust its own BullMQ attempts.
 */
export const ocrRecoveryConfig = (): OcrRecoveryConfig => {
  const graceMs = Math.max(
    5_000,
    positiveNumber(process.env.OCR_FAILURE_GRACE_SECONDS, 30) * 1_000,
  );
  const retryDelayMs = Math.min(
    graceMs,
    Math.max(
      1_000,
      positiveNumber(process.env.OCR_TECHNICAL_RETRY_SECONDS, 10) * 1_000,
    ),
  );
  return {
    graceMs,
    retryDelayMs,
    attempts: Math.max(2, Math.ceil(graceMs / retryDelayMs) + 1),
    sweepMs: Math.min(
      graceMs,
      Math.max(
        1_000,
        positiveNumber(process.env.OCR_RECOVERY_SWEEP_SECONDS, 5) * 1_000,
      ),
    ),
  };
};

export const ocrJobOptions = () => {
  const config = ocrRecoveryConfig();
  return {
    attempts: config.attempts,
    backoff: { type: "fixed" as const, delay: config.retryDelayMs },
  };
};

/** Deduplicate retries of one upload, but never deduplicate a replacement. */
export function orderPassportOcrJobId(
  orderId: string,
  documentId: string,
  privateAssetId: string,
) {
  const upload = createHash("sha256")
    .update(privateAssetId)
    .digest("hex")
    .slice(0, 24);
  return `order-passport-${orderId}-${documentId}-${upload}`;
}
