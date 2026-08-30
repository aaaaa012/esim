import { describe, expect, it } from "vitest";
import { fonepayBankIntentUrl } from "./payment-intent";

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
