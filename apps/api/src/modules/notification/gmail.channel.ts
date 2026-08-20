import { Injectable, ServiceUnavailableException } from "@nestjs/common";

export type GmailAttachment = {
  filename: string;
  contentType: string;
  base64: string;
};

@Injectable()
export class GmailChannel {
  async send(input: {
    to: string;
    subject: string;
    text: string;
    attachment?: GmailAttachment;
  }) {
    if (process.env.NOTIFICATION_MODE !== "live")
      return { providerMessageId: `gmail-sim-${Date.now()}`, simulated: true };
    const {
      GMAIL_CLIENT_ID: clientId,
      GMAIL_CLIENT_SECRET: clientSecret,
      GMAIL_REFRESH_TOKEN: refreshToken,
    } = process.env;
    if (!clientId || !clientSecret || !refreshToken) {
      if (process.env.NODE_ENV !== "production")
        return {
          providerMessageId: `gmail-sim-${Date.now()}`,
          simulated: true,
        };
      throw new ServiceUnavailableException("Gmail delivery is not configured");
    }
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenResponse.ok)
      throw new ServiceUnavailableException("Gmail OAuth refresh failed");
    const token = (await tokenResponse.json()) as { access_token: string };
    const from = process.env.GMAIL_FROM_ADDRESS ?? "me";
    const mime = this.buildMime({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.attachment ? { attachment: input.attachment } : {}),
    });
    const raw = Buffer.from(mime).toString("base64url");
    const sendResponse = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw }),
      },
    );
    if (!sendResponse.ok)
      throw new ServiceUnavailableException("Gmail message delivery failed");
    const result = (await sendResponse.json()) as { id: string };
    return { providerMessageId: result.id, simulated: false };
  }

  private buildMime(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    attachment?: GmailAttachment;
  }): string {
    const headerValue = (value: string) =>
      value.replace(/[\r\n]+/g, " ").trim();
    const headers = [
      `From: ${headerValue(input.from)}`,
      `To: ${headerValue(input.to)}`,
      `Subject: ${headerValue(input.subject)}`,
      "MIME-Version: 1.0",
    ];
    if (!input.attachment) {
      return [
        ...headers,
        "Content-Type: text/plain; charset=UTF-8",
        "",
        input.text,
      ].join("\r\n");
    }
    const boundary = `----=_boundary_${Date.now().toString(36)}`;
    return [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      input.text,
      `--${boundary}`,
      `Content-Type: ${input.attachment.contentType}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${input.attachment.filename.replace(/["\r\n]/g, "_")}"`,
      "",
      input.attachment.base64,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
}
