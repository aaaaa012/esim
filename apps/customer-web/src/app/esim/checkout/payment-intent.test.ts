import { describe, expect, it } from "vitest";
import { filterFonepayBanks, fonepayBankIntentUrl } from "./payment-intent";

describe("fonepayBankIntentUrl", () => {
  it("uses the documented issuer deep-link shape", () => {
    expect(fonepayBankIntentUrl("ExampleBank://payment", "a+b/c=")).toBe(
      "examplebank://payment/?qrPayload=a%2Bb%2Fc%3D",
    );
  });

  it("rejects browser and executable schemes", () => {
    expect(fonepayBankIntentUrl("javascript:alert", "payload")).toBeNull();
    expect(fonepayBankIntentUrl("https://bank.example", "payload")).toBeNull();
    expect(fonepayBankIntentUrl("data:text/plain", "payload")).toBeNull();
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
