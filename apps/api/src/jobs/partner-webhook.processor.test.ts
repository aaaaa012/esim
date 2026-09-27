import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeWebhookUrl,
  signPartnerWebhook,
} from "./partner-webhook.processor.js";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("partner webhook transport security", () => {
  it("signs the timestamp and exact raw body", () => {
    expect(signPartnerWebhook("secret", "1700000000", '{"id":"1"}')).toBe(
      "086f6aff7bd084c98679825129c5a64dbad88c760016d6d2c0fb123f27951d54",
    );
  });

  it("rejects private and loopback destinations", async () => {
    await expect(
      assertSafeWebhookUrl("https://127.0.0.1/callback"),
    ).rejects.toThrow(/private host/i);
    await expect(
      assertSafeWebhookUrl("https://10.0.0.1/callback"),
    ).rejects.toThrow(/private host/i);
  });

  it("requires HTTPS in production", async () => {
    process.env.NODE_ENV = "production";
    await expect(
      assertSafeWebhookUrl("http://203.0.113.10/callback"),
    ).rejects.toThrow("Webhook URL must use HTTPS in production");
  });
});
