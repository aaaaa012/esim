import { describe, expect, it } from "vitest";
import {
  documentReviewLabel,
  orderEventLabel,
  orderSourceLabel,
} from "./review-status";

describe("operations order context", () => {
  it("uses the purchase channel for hosted, API, and direct orders", () => {
    expect(orderSourceLabel("PARTNER_HOSTED", true)).toBe(
      "Partner hosted checkout",
    );
    expect(orderSourceLabel("PARTNER_API", true)).toBe("Partner API");
    expect(orderSourceLabel("CUSTOMER_WEB")).toBe("Direct website checkout");
    expect(orderSourceLabel(undefined, true)).toBe("Partner");
    expect(orderSourceLabel()).toBe("Not recorded");
  });

  it("shows passport OCR separately from the pending ticket's manual review", () => {
    expect(
      documentReviewLabel(
        { type: "PASSPORT", status: "PENDING", uploadVerified: true },
        "VERIFIED",
      ),
    ).toBe("Verified automatically");
    expect(
      documentReviewLabel(
        { type: "TICKET", status: "PENDING", uploadVerified: true },
        "VERIFIED",
      ),
    ).toBe("Uploaded · awaiting manual review");
    expect(
      documentReviewLabel({ type: "VISA", status: "PENDING" }, "VERIFIED"),
    ).toBe("Awaiting manual review");
  });

  it("never masks re-upload requests, failed verification, or policy skips with an approval", () => {
    expect(
      documentReviewLabel(
        { type: "PASSPORT", status: "REUPLOAD_REQUIRED" },
        "VERIFIED",
      ),
    ).toBe("REUPLOAD_REQUIRED");
    expect(
      documentReviewLabel({ type: "PASSPORT", status: "PENDING" }, "FAILED"),
    ).toBe("Awaiting manual review");
    expect(
      documentReviewLabel({ type: "PASSPORT", status: "PENDING" }, "SKIPPED"),
    ).toBe("Awaiting manual review");
    expect(
      documentReviewLabel(
        { type: "PASSPORT", status: "APPROVED" },
        "MANUALLY_APPROVED",
      ),
    ).toBe("Approved");
  });

  it("distinguishes verification events from order creation and activation approval", () => {
    expect(
      orderEventLabel({
        from: "DRAFT",
        to: "DRAFT",
        reason: "Passport verified automatically",
      }),
    ).toBe("Passport verified");
    expect(orderEventLabel({ from: null, to: "DRAFT" })).toBe("DRAFT");
    expect(
      orderEventLabel({
        from: "PAYMENT_CONFIRMED",
        to: "APPROVED",
        reason: "Auto-approved after payment",
      }),
    ).toBe("Approved for activation");
    expect(orderEventLabel({ from: "PROVISIONING", to: "QR_READY" })).toBe(
      "QR_READY",
    );
  });
});
