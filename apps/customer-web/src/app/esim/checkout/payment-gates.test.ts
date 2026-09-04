import { describe, expect, it } from "vitest";
import { paymentActionDisabled } from "./payment-gates";

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
});
