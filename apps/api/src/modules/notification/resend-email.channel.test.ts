import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { ResendEmailChannel } from "./resend-email.channel.js";

describe("ResendEmailChannel", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("simulates delivery without contacting Resend", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "simulator");

    const result = await new ResendEmailChannel().send({
      to: "traveler@example.com",
      subject: "Ready",
      text: "Your eSIM is ready.",
      idempotencyKey: "notification-1",
    });

    expect(result.simulated).toBe(true);
    expect(result.providerMessageId).toMatch(/^resend-sim-/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends text and a base64 QR attachment with an idempotency key", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "live");
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "resend-key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "notifications@example.com");
    vi.stubEnv("EMAIL_FROM_NAME", "Visa Compass");
    vi.stubEnv("EMAIL_REPLY_TO", "support@example.com");
    sendMock.mockResolvedValue({ data: { id: "email-123" }, error: null });

    const result = await new ResendEmailChannel().send({
      to: "traveler@example.com",
      subject: "Your installation QR",
      text: "Install your eSIM.",
      idempotencyKey: "notification-1",
      attachment: {
        filename: "qr.png",
        contentType: "image/png",
        base64: "cG5n",
      },
    });

    expect(result).toEqual({
      providerMessageId: "email-123",
      simulated: false,
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Visa Compass <notifications@example.com>",
        to: ["traveler@example.com"],
        replyTo: "support@example.com",
        attachments: [
          {
            filename: "qr.png",
            contentType: "image/png",
            content: "cG5n",
          },
        ],
      }),
      { idempotencyKey: "notification-1" },
    );
  });

  it("rejects live delivery when Resend is not configured", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "live");
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "");

    await expect(
      new ResendEmailChannel().send({
        to: "traveler@example.com",
        subject: "Ready",
        text: "Your eSIM is ready.",
      }),
    ).rejects.toThrow("Email delivery is not configured");
  });

  it.each([
    { name: "invalid key", statusCode: 401 },
    { name: "rate limit", statusCode: 429 },
    { name: "transient provider failure", statusCode: 503 },
  ])("sanitizes $name errors for queue retries", async ({ statusCode }) => {
    vi.stubEnv("NOTIFICATION_MODE", "live");
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "resend-key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "notifications@example.com");
    sendMock.mockResolvedValue({
      data: null,
      error: {
        statusCode,
        message: "secret provider response containing recipient data",
      },
    });

    const delivery = new ResendEmailChannel().send({
      to: "traveler@example.com",
      subject: "Ready",
      text: "Your eSIM is ready.",
    });

    await expect(delivery).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(delivery).rejects.toThrow(
      "Email delivery was rejected by provider",
    );
  });
});
