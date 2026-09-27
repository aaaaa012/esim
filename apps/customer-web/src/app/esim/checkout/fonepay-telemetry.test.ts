import { describe, expect, it, vi } from "vitest";
import {
  fonepayPlatform,
  postFonepayTelemetry,
} from "./fonepay-telemetry";

function withUserAgent<T>(ua: string, run: () => T): T {
  const original = navigator.userAgent;
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(navigator, "userAgent", {
      value: original,
      configurable: true,
    });
  }
}

describe("fonepayPlatform", () => {
  it("maps Android and iOS user agents and defaults the rest to desktop", () => {
    expect(
      withUserAgent("Mozilla/5.0 (Linux; Android 14) Mobile", fonepayPlatform),
    ).toBe("ANDROID");
    expect(
      withUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", fonepayPlatform),
    ).toBe("IOS");
    expect(
      withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64)", fonepayPlatform),
    ).toBe("DESKTOP");
  });
});

describe("postFonepayTelemetry", () => {
  it("posts a categorical event with the platform and keepalive", () => {
    withUserAgent("Mozilla/5.0 (Linux; Android 14) Mobile", () => {
      const send = vi.fn().mockResolvedValue(undefined);

      postFonepayTelemetry(
        send,
        "/customer/orders/order-1/payment/telemetry",
        "VC-2026-ABCD",
        {
          event: "BANK_LAUNCH_BLOCKED",
          bankCode: "NICEA",
          bankName: "NIC Asia",
          reason: "SOCKET_NOT_READY",
        },
      );

      expect(send).toHaveBeenCalledTimes(1);
      const [endpoint, init] = send.mock.calls[0]!;
      expect(endpoint).toBe("/customer/orders/order-1/payment/telemetry");
      expect(init).toMatchObject({ method: "POST", keepalive: true });
      expect(JSON.parse(init.body as string)).toEqual({
        reference: "VC-2026-ABCD",
        platform: "ANDROID",
        event: "BANK_LAUNCH_BLOCKED",
        bankCode: "NICEA",
        bankName: "NIC Asia",
        reason: "SOCKET_NOT_READY",
      });
    });
  });

  it("does not post without a reference", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    postFonepayTelemetry(send, "/any", undefined, { event: "QR_RENDERED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a rejected send so diagnostics never break checkout", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    expect(() =>
      postFonepayTelemetry(send, "/any", "VC-2026-ABCD", {
        event: "QR_RENDERED",
      }),
    ).not.toThrow();
    await Promise.resolve();
  });
});
