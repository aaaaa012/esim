import { describe, expect, it } from "vitest";
import {
  checkoutResumeDisposition,
  checkoutResumeStep,
  paymentStatusHeading,
} from "./checkout-resume";

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

describe("checkoutResumeStep", () => {
  const draft = { status: "DRAFT", purchaseType: "INITIAL_PURCHASE" };

  it("returns to traveller details when they have not been saved", () => {
    expect(checkoutResumeStep(draft)).toBe(2);
  });

  it("returns to documents when required verification is incomplete", () => {
    expect(
      checkoutResumeStep({
        ...draft,
        traveler: { firstName: "Samira" },
        documents: [],
        documentReviewStatus: "NOT_STARTED",
      }),
    ).toBe(3);
  });

  it("returns to payment only after the document gate passes", () => {
    expect(
      checkoutResumeStep({
        ...draft,
        traveler: { firstName: "Samira" },
        documents: [
          { type: "PASSPORT", uploadVerified: true },
          { type: "TICKET", uploadVerified: true },
        ],
        documentReviewStatus: "VERIFIED",
      }),
    ).toBe(4);
  });

  it.each([
    [{ ...draft, purchaseType: "TOPUP" }, 4],
    [{ ...draft, status: "PAYMENT_PENDING" }, 4],
    [{ ...draft, status: "COMPLETED" }, 4],
  ])("keeps payment and post-payment orders at payment", (order, expected) => {
    expect(checkoutResumeStep(order)).toBe(expected);
  });
});

describe("paymentStatusHeading", () => {
  it("uses the persisted provider without assuming Khalti", () => {
    expect(paymentStatusHeading("FONEPAY")).toBe(
      "Checking Fonepay payment status",
    );
    expect(paymentStatusHeading("KHALTI")).toBe(
      "Checking Khalti payment status",
    );
    expect(paymentStatusHeading()).toBe("Checking payment status");
  });
});
