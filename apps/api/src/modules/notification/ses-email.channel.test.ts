import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send = sendMock;
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { SesEmailChannel } from "./ses-email.channel.js";

describe("SesEmailChannel", () => {
  beforeEach(() => sendMock.mockReset());
  afterEach(() => vi.unstubAllEnvs());

  it("simulates delivery without contacting SES", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "simulator");

    const result = await new SesEmailChannel().send({
      to: "traveler@example.com",
      subject: "Ready",
      text: "Your eSIM is ready.",
    });

    expect(result.simulated).toBe(true);
    expect(result.providerMessageId).toMatch(/^ses-sim-/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends text, HTML, reply-to and a QR attachment", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "live");
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    vi.stubEnv("AWS_REGION", "ap-south-1");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "notifications@example.com");
    vi.stubEnv("EMAIL_FROM_NAME", "Visa Compass");
    vi.stubEnv("EMAIL_REPLY_TO", "support@example.com");
    sendMock.mockResolvedValue({ MessageId: "ses-message-123" });

    const result = await new SesEmailChannel().send({
      to: "traveler@example.com",
      subject: "Your installation QR",
      text: "Install your eSIM.",
      html: "<p>Install your eSIM.</p>",
      attachment: {
        filename: "qr.png",
        contentType: "image/png",
        base64: "cG5n",
      },
    });

    expect(result).toEqual({
      providerMessageId: "ses-message-123",
      simulated: false,
    });
    const command = sendMock.mock.calls[0]?.[0] as {
      input: Record<string, any>;
    };
    expect(command.input).toEqual(
      expect.objectContaining({
        FromEmailAddress: "Visa Compass <notifications@example.com>",
        Destination: { ToAddresses: ["traveler@example.com"] },
        ReplyToAddresses: ["support@example.com"],
      }),
    );
    expect(command.input.Content.Simple.Attachments[0]).toEqual(
      expect.objectContaining({
        FileName: "qr.png",
        ContentType: "image/png",
        RawContent: Buffer.from("png"),
      }),
    );
  });

  it("rejects live delivery when SES is not configured", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "live");
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "");

    await expect(
      new SesEmailChannel().send({
        to: "traveler@example.com",
        subject: "Ready",
        text: "Your eSIM is ready.",
      }),
    ).rejects.toThrow("Email delivery is not configured");
  });

  it("sanitizes provider failures for queue retries", async () => {
    vi.stubEnv("NOTIFICATION_MODE", "live");
    vi.stubEnv("EMAIL_PROVIDER", "ses");
    vi.stubEnv("AWS_REGION", "ap-south-1");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "notifications@example.com");
    sendMock.mockImplementationOnce(async () => {
      throw new Error("secret provider response containing recipient data");
    });

    const delivery = new SesEmailChannel().send({
      to: "traveler@example.com",
      subject: "Ready",
      text: "Your eSIM is ready.",
    });

    const error = await delivery.catch((caught) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error).toHaveProperty(
      "message",
      "Email delivery was rejected by provider",
    );
  });
});
