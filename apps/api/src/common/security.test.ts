import { beforeEach, describe, expect, it } from "vitest";
import { clientIp } from "./client-ip.js";
import { redactUrl } from "./redact.js";
import { tabularToRecords } from "./tabular.util.js";
import { trustProxySetting } from "./trust-proxy.js";

describe("trustProxySetting", () => {
  beforeEach(() => delete process.env.TRUST_PROXY);

  it("rejects blanket trust and accepts bounded explicit proxy settings", () => {
    process.env.TRUST_PROXY = "true";
    expect(() => trustProxySetting()).toThrow(/unsafe/i);
    process.env.TRUST_PROXY = "1";
    expect(trustProxySetting()).toBe(1);
    process.env.TRUST_PROXY = "10.0.0.0/8, loopback";
    expect(trustProxySetting()).toBe("10.0.0.0/8, loopback");
  });
});

describe("redactUrl", () => {
  it("leaves URLs without a query string untouched", () => {
    expect(redactUrl("/api/v1/health")).toBe("/api/v1/health");
  });

  it("redacts sensitive query parameters", () => {
    const result = redactUrl(
      "/api/v1/operations/topup/lookup?mobile=%2B9779841234567&limit=5",
    );
    expect(result).toContain("mobile=[redacted]");
    expect(result).not.toContain("9841234567");
    expect(result).toContain("limit=5");
  });

  it("redacts tokens, emails and references", () => {
    const result = redactUrl(
      "/x?token=abc123&email=a%40b.c&reference=REF&keep=1",
    );
    expect(result).toBe(
      "/x?token=[redacted]&email=[redacted]&reference=[redacted]&keep=1",
    );
  });
});

describe("clientIp", () => {
  it("never trusts a spoofable forwarded header when ip/socket not present", () => {
    expect(
      clientIp({ headers: { "x-forwarded-for": "6.6.6.6" } } as never),
    ).toBe("unknown");
  });

  it("uses req.ip when present", () => {
    expect(clientIp({ ip: "203.0.113.9" })).toBe("203.0.113.9");
  });

  it("falls back to the socket address", () => {
    expect(clientIp({ socket: { remoteAddress: "10.0.0.5" } })).toBe(
      "10.0.0.5",
    );
  });
});

describe("tabularToRecords oversized guard", () => {
  it("rejects content larger than the safety ceiling without parsing", async () => {
    const huge = "a".repeat(16 * 1024 * 1024);
    const { records, errors } = await tabularToRecords(huge, ["iccid"]);
    expect(records).toEqual([]);
    expect(errors[0]).toContain("too large");
  });
});
