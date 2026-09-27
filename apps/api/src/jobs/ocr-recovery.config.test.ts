import { afterEach, describe, expect, it } from "vitest";
import {
  ocrJobOptions,
  ocrRecoveryConfig,
  orderPassportOcrJobId,
} from "./ocr-recovery.config.js";

const original = {
  grace: process.env.OCR_FAILURE_GRACE_SECONDS,
  retry: process.env.OCR_TECHNICAL_RETRY_SECONDS,
  sweep: process.env.OCR_RECOVERY_SWEEP_SECONDS,
};

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("OCR_FAILURE_GRACE_SECONDS", original.grace);
  restore("OCR_TECHNICAL_RETRY_SECONDS", original.retry);
  restore("OCR_RECOVERY_SWEEP_SECONDS", original.sweep);
});

describe("OCR recovery configuration", () => {
  it("waits thirty seconds by default before manual fallback", () => {
    delete process.env.OCR_FAILURE_GRACE_SECONDS;
    delete process.env.OCR_TECHNICAL_RETRY_SECONDS;
    delete process.env.OCR_RECOVERY_SWEEP_SECONDS;

    expect(ocrRecoveryConfig()).toEqual({
      graceMs: 30_000,
      retryDelayMs: 10_000,
      attempts: 4,
      sweepMs: 5_000,
    });
    expect(ocrJobOptions()).toEqual({
      attempts: 4,
      backoff: { type: "fixed", delay: 10_000 },
    });
  });

  it("derives enough attempts to cover a configured grace window", () => {
    process.env.OCR_FAILURE_GRACE_SECONDS = "45";
    process.env.OCR_TECHNICAL_RETRY_SECONDS = "10";
    process.env.OCR_RECOVERY_SWEEP_SECONDS = "5";

    expect(ocrRecoveryConfig()).toMatchObject({
      graceMs: 45_000,
      retryDelayMs: 10_000,
      attempts: 6,
      sweepMs: 5_000,
    });
  });
});

it("deduplicates retries of the same upload but not a replacement in the same row", () => {
  const first = orderPassportOcrJobId("order", "passport", "original-upload");
  expect(orderPassportOcrJobId("order", "passport", "original-upload")).toBe(
    first,
  );
  expect(
    orderPassportOcrJobId("order", "passport", "replacement-upload"),
  ).not.toBe(first);
  expect(
    orderPassportOcrJobId(
      "order",
      "passport",
      "original-upload",
      "corrected-traveller-details",
    ),
  ).not.toBe(first);
  expect(
    orderPassportOcrJobId(
      "order",
      "passport",
      "original-upload",
      "replacement:2026-09-22T00:00:00.000Z",
    ),
  ).not.toBe(first);
});
