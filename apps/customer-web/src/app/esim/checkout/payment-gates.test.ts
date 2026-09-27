import { describe, expect, it } from "vitest";
import { paymentActionDisabled, retryDeclaredAllowed } from "./payment-gates";

describe("paymentActionDisabled", () => {
  it("allows a top-up without passport verification", () => {
    expect(
      paymentActionDisabled({
        isTopUp: true,
        verifyingPassport: false,
        passportGatePassed: false,
      }),
    ).toBe(false);
  });

  it("keeps passport verification mandatory for an initial purchase", () => {
    expect(
      paymentActionDisabled({
        isTopUp: false,
        verifyingPassport: false,
        passportGatePassed: false,
      }),
    ).toBe(true);
  });

  it("blocks the action while verification is running", () => {
    expect(
      paymentActionDisabled({
        isTopUp: true,
        verifyingPassport: true,
        passportGatePassed: false,
      }),
    ).toBe(true);
  });

  it("blocks a new payment attempt when the server declared retry unsafe", () => {
    expect(
      paymentActionDisabled({
        isTopUp: true,
        verifyingPassport: false,
        passportGatePassed: false,
        retryAllowed: false,
      }),
    ).toBe(true);
  });

  it("keeps status-check controls enabled when retry is unsafe (field omitted)", () => {
    expect(
      paymentActionDisabled({
        isTopUp: false,
        verifyingPassport: false,
        passportGatePassed: true,
      }),
    ).toBe(false);
  });
});

describe("retryDeclaredAllowed", () => {
  it("allows when no declaration is present (server remains authoritative)", () => {
    expect(retryDeclaredAllowed(undefined, "canRetry")).toBe(true);
    expect(retryDeclaredAllowed(null, "canChangeProvider")).toBe(true);
  });

  it("allows a declared retry and provider switch on a failed payment", () => {
    const declaration = { canRetry: true, canChangeProvider: true };
    expect(retryDeclaredAllowed(declaration, "canRetry")).toBe(true);
    expect(retryDeclaredAllowed(declaration, "canChangeProvider")).toBe(true);
  });

  it("blocks a provider switch when the server declared it unsafe", () => {
    expect(
      retryDeclaredAllowed(
        { canRetry: false, canChangeProvider: false },
        "canChangeProvider",
      ),
    ).toBe(false);
  });

  it("defaults a missing field to allowed", () => {
    expect(
      retryDeclaredAllowed({ canRetry: true } as never, "canChangeProvider"),
    ).toBe(true);
  });
});
