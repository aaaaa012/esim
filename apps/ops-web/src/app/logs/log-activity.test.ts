import { describe, expect, it } from "vitest";
import { activityLabel } from "./log-activity";

describe("activityLabel", () => {
  it("labels Khalti provider calls", () => {
    expect(
      activityLabel({
        group: "provider",
        identifier: "khalti-initiation",
        title: "POST /epayment/initiate/",
      }),
    ).toBe("Khalti Payment Initiation");
  });

  it("labels Transatel provider calls", () => {
    expect(
      activityLabel({
        group: "provider",
        identifier: "subscriber-suspend",
        title: "POST /subscribers/suspend",
      }),
    ).toBe("Transatel eSIM Suspension");
  });

  it("labels incoming callbacks", () => {
    expect(
      activityLabel({
        group: "incoming",
        identifier: "Khalti",
        title: "payment-event-1",
      }),
    ).toBe("Khalti Payment Callback Received");
  });

  it("uses a generic label for unknown providers", () => {
    expect(
      activityLabel({
        group: "provider",
        identifier: "unknown-operation",
        title: "POST /external/check",
      }),
    ).toBe("Transatel Service Request");
  });

  it.each([
    ["partner-api", "Partner API Request"],
    ["customer-topup-lookup", "Customer eSIM Lookup"],
    ["customer-topup-eligibility", "Customer Top-up Eligibility"],
  ])("labels %s operations", (identifier, label) => {
    expect(
      activityLabel({ group: "provider", identifier, title: "POST /request" }),
    ).toBe(label);
  });
});
