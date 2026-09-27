import { describe, expect, it, vi } from "vitest";
import { boundedRetryAfter, safeInternalReturnTo, verifyPortalSession } from "./portal-session.js";

describe("portal session verification", () => {
  it("accepts only same-origin relative return destinations", () => {
    expect(safeInternalReturnTo("/account/orders?open=1")).toBe("/account/orders?open=1");
    expect(safeInternalReturnTo("//evil.test/path")).toBe("/");
    expect(safeInternalReturnTo("https://evil.test/path")).toBe("/");
  });

  it("maps rate limits without retrying and bounds Retry-After", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "999" } }));
    const result = await verifyPortalSession({ apiUrl: "https://api.test", token: "token", allowedAccountTypes: ["CUSTOMER"], fetcher, sleep: async () => undefined });
    expect(result.decision).toBe("RATE_LIMITED");
    expect(result.retryAfterSeconds).toBe(60);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(boundedRetryAfter("invalid")).toBe(10);
  });

  it("retries one eligible outage and preserves a successful authorization", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "UPSTREAM" } }), { status: 503, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { accountType: "SUPER_ADMIN", mustChangePassword: false } }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await verifyPortalSession({ apiUrl: "https://api.test", token: "token", allowedAccountTypes: ["OPERATIONS", "SUPER_ADMIN"], fetcher, sleep: async () => undefined });
    expect(result.decision).toBe("ALLOW");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves status routing when an intermediary strips the JSON body", async () => {
    const unauthorized = await verifyPortalSession({ apiUrl: "https://api.test", token: "token", allowedAccountTypes: ["CUSTOMER"], fetcher: async () => new Response(null, { status: 401 }), sleep: async () => undefined });
    const limited = await verifyPortalSession({ apiUrl: "https://api.test", token: "token", allowedAccountTypes: ["CUSTOMER"], fetcher: async () => new Response(null, { status: 429, headers: { "retry-after": "10" } }), sleep: async () => undefined });
    expect(unauthorized.decision).toBe("SIGN_IN");
    expect(limited.decision).toBe("RATE_LIMITED");
    expect(limited.retryAfterSeconds).toBe(10);
  });
});
