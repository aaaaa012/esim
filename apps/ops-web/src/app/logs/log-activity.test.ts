import { describe, expect, it } from "vitest";
import { activityLabel, providerLabel } from "./log-activity";

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
    ).toBe("External Provider Service Request");
  });

  it.each([
    [
      "fonepay-authentication",
      "POST /merchantDetailsForThirdParty/v2/login",
      "Fonepay Authentication",
    ],
    [
      "fonepay-list",
      "GET /api/merchant/third-party/v2/banks/list",
      "Fonepay Bank List",
    ],
    [
      "fonepay-generate-intent-qr",
      "POST /api/merchant/third-party/v2/generate-intent-qr",
      "Fonepay Payment Initiation",
    ],
    [
      "fonepay-thirdPartyDynamicQrGetStatus",
      "POST /api/merchant/third-party/v2/thirdPartyDynamicQrGetStatus",
      "Fonepay Payment Status Lookup",
    ],
  ])("labels %s as a Fonepay operation", (identifier, title, label) => {
    const entry = { group: "provider" as const, identifier, title };
    expect(providerLabel(entry)).toBe("Fonepay");
    expect(activityLabel(entry)).toBe(label);
  });

  it.each([
    ["fonepay-client-qr-rendered", "Fonepay QR Displayed"],
    [
      "fonepay-client-socket-connected",
      "Fonepay WebSocket Connected",
    ],
    ["fonepay-client-socket-error", "Fonepay WebSocket Error"],
    ["fonepay-client-socket-closed", "Fonepay WebSocket Closed"],
    [
      "fonepay-client-qr-verified-signal",
      "Fonepay QR Scan Recognized",
    ],
    [
      "fonepay-client-payment-result-signal",
      "Fonepay Payment Result Signal Received",
    ],
    [
      "fonepay-client-bank-launch-attempted",
      "Fonepay Banking App Launch Attempted",
    ],
    [
      "fonepay-client-bank-launch-blocked",
      "Fonepay Banking App Launch Blocked",
    ],
    [
      "fonepay-client-bank-app-navigation-observed",
      "Fonepay Banking App Opened",
    ],
  ])("labels %s client telemetry", (identifier, label) => {
    const entry = {
      group: "provider" as const,
      identifier,
      title: "customer-checkout",
    };
    expect(providerLabel(entry)).toBe("Fonepay");
    expect(activityLabel(entry)).toBe(label);
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
