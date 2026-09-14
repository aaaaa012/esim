import { describe, expect, it } from "vitest";
import {
  checkoutDetailsLocked,
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
  ])("keeps %s resumable inside checkout", (status) => {
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

describe("checkoutDetailsLocked", () => {
  it.each([
    { status: "PAYMENT_PENDING" },
    { status: "DRAFT", payment: { status: "PENDING" } },
    { status: "PAYMENT_CONFIRMED", payment: { status: "COMPLETED" } },
  ])("locks the submitted payment snapshot", (order) => {
    expect(checkoutDetailsLocked(order)).toBe(true);
  });

  it.each([
    { status: "DRAFT" },
    { status: "PAYMENT_FAILED", payment: { status: "FAILED" } },
  ])("allows edits when no active payment can still settle", (order) => {
    expect(checkoutDetailsLocked(order)).toBe(false);
  });
});

describe("checkoutResumeStep", () => {
  const draft = { status: "DRAFT", purchaseType: "INITIAL_PURCHASE" };

  it("returns to documents when required uploads have not been saved", () => {
    expect(checkoutResumeStep(draft)).toBe(2);
  });

  it("returns to documents even when a legacy draft already has traveler data", () => {
    expect(
      checkoutResumeStep({
        ...draft,
        traveler: { firstName: "Samira" },
        documents: [],
        documentReviewStatus: "NOT_STARTED",
      }),
    ).toBe(2);
  });

  it("returns to traveler confirmation after both uploads are confirmed", () => {
    expect(
      checkoutResumeStep({
        ...draft,
        documents: [
          { type: "PASSPORT", uploadVerified: true },
          { type: "TICKET", uploadVerified: true },
        ],
        passportExtraction: { status: "READY" },
        documentReviewStatus: "NOT_STARTED",
      }),
    ).toBe(3);
  });

  it("resumes a partial extraction with saved traveller data at traveller review", () => {
    expect(
      checkoutResumeStep({
        ...draft,
        traveler: { firstName: "Anish", surname: "Ghimire" },
        documents: [
          { type: "PASSPORT", uploadVerified: true },
          { type: "TICKET", uploadVerified: true },
        ],
        passportExtraction: { status: "PARTIAL" },
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
