import { describe, expect, it } from "vitest";
import { isSensitivePartnerLogKey } from "./partner-api-logging.interceptor.js";

describe("partner API log redaction", () => {
  it("recognizes camelCase and separator variants of secret and personal fields", () => {
    for (const key of [
      "clientSecret",
      "webhook-secret",
      "guestAccessToken",
      "apiKeyValue",
      "passportNumber",
      "qrPayload",
      "recoveryURL",
    ])
      expect(isSensitivePartnerLogKey(key), key).toBe(true);
    expect(isSensitivePartnerLogKey("orderStatus")).toBe(false);
  });
});
