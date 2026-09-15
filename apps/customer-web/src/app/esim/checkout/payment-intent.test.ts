import { describe, expect, it } from "vitest";
import {
  filterFonepayBanks,
  fonepayBankAndroidIntentUrl,
  fonepayBankIntentUrl,
  fonepaySocketSignal,
} from "./payment-intent";

describe("fonepayBankIntentUrl", () => {
  it("uses the documented issuer deep-link shape", () => {
    expect(fonepayBankIntentUrl("LXBLNPKA://payment", "a+b/c=")).toBe(
      "LXBLNPKA://payment/?qrPayload=a%2Bb%2Fc%3D",
    );
    expect(fonepayBankIntentUrl("fonepay", "payload")).toBe(
      "fonepay://payment/?qrPayload=payload",
    );
  });

  it("rejects browser and executable schemes", () => {
    expect(fonepayBankIntentUrl("javascript:alert", "payload")).toBeNull();
    expect(fonepayBankIntentUrl("https://bank.example", "payload")).toBeNull();
    expect(fonepayBankIntentUrl("data:text/plain", "payload")).toBeNull();
    expect(
      fonepayBankIntentUrl("safe://attacker.example", "payload"),
    ).toBeNull();
  });
});

describe("fonepaySocketSignal", () => {
  it("distinguishes QR verification from the final payment result", () => {
    expect(
      fonepaySocketSignal(
        JSON.stringify({
          transactionStatus: JSON.stringify({
            success: true,
            QRVerified: true,
          }),
        }),
      ),
    ).toBe("QR_VERIFIED");
    expect(
      fonepaySocketSignal({ transactionStatus: { paymentSuccess: true } }),
    ).toBe("PAYMENT_RESULT");
    expect(fonepaySocketSignal("not-json")).toBe("IGNORE");
  });
});

describe("fonepayBankAndroidIntentUrl", () => {
  it("pins the issuer package per V1.10 section 8", () => {
    const url = fonepayBankAndroidIntentUrl(
      "LXBLNPKA://payment",
      "a+b/c=",
      "com.lxblnpka.app",
    );
    expect(url).toBe(
      "intent://payment/?qrPayload=a%2Bb%2Fc%3D#Intent;" +
        "scheme=LXBLNPKA;package=com.lxblnpka.app;end",
    );
  });

  it("falls back to a null and keeps the plain deep link usable", () => {
    expect(
      fonepayBankAndroidIntentUrl("LXBLNPKA://payment", "payload", "bad pkg!"),
    ).toBeNull();
    expect(
      fonepayBankAndroidIntentUrl("javascript:bad", "payload", "com.bad.app"),
    ).toBeNull();
    expect(fonepayBankIntentUrl("LXBLNPKA://payment", "payload")).toBe(
      "LXBLNPKA://payment/?qrPayload=payload",
    );
  });
});

describe("filterFonepayBanks", () => {
  const banks = [
    { bankName: "Laxmi Sunrise Bank", bankCode: "LXBLNPKA" },
    { bankName: "Nabil Bank", bankCode: "NARBNPKA" },
  ];

  it("searches by a case-insensitive bank name or code", () => {
    expect(filterFonepayBanks(banks, "sunrise")).toEqual([banks[0]]);
    expect(filterFonepayBanks(banks, "narb")).toEqual([banks[1]]);
  });

  it("returns the full provider list for an empty search", () => {
    expect(filterFonepayBanks(banks, "  ")).toEqual(banks);
  });
});
