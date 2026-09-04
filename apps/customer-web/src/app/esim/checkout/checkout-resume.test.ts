import { describe, expect, it } from "vitest";
import { checkoutResumeDisposition } from "./checkout-resume";

describe("checkoutResumeDisposition", () => {
  it.each([
    "DRAFT",
    "PAYMENT_PENDING",
    "PAYMENT_FAILED",
    "PAYMENT_REVIEW_REQUIRED",
  ])("keeps %s in the editable checkout flow", (status) => {
    expect(checkoutResumeDisposition(status)).toBe("EDITABLE");
  });

  it.each([
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
  ])("renders %s in checkout's post-payment status view", (status) => {
    expect(checkoutResumeDisposition(status)).toBe("POST_PAYMENT");
  });

  it("rejects unknown states instead of guessing their checkout behavior", () => {
    expect(checkoutResumeDisposition("UNKNOWN_STATE")).toBe("UNSUPPORTED");
  });
});
