import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Resend } from "resend";
import type {
  EmailChannel,
  EmailSendInput,
  EmailSendResult,
} from "./email.channel.js";

@Injectable()
export class ResendEmailChannel implements EmailChannel {
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    if (process.env.NOTIFICATION_MODE !== "live") {
      return {
        providerMessageId: `resend-sim-${Date.now()}`,
        simulated: true,
      };
    }

    const apiKey = process.env.RESEND_API_KEY;
    const fromAddress = process.env.EMAIL_FROM_ADDRESS;
    if (process.env.EMAIL_PROVIDER !== "resend" || !apiKey || !fromAddress) {
      throw new ServiceUnavailableException("Email delivery is not configured");
    }

    const fromName = process.env.EMAIL_FROM_NAME?.trim();
    const resend = new Resend(apiKey);
    try {
      const { data, error } = await resend.emails.send(
        {
          from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          ...(input.html ? { html: input.html } : {}),
          ...(process.env.EMAIL_REPLY_TO
            ? { replyTo: process.env.EMAIL_REPLY_TO }
            : {}),
          ...(input.attachment
            ? {
                attachments: [
                  {
                    filename: input.attachment.filename,
                    content: input.attachment.base64,
                    contentType: input.attachment.contentType,
                  },
                ],
              }
            : {}),
        },
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );
      if (error || !data?.id) {
        throw new Error("provider rejected the message");
      }
      return { providerMessageId: data.id, simulated: false };
    } catch {
      // Provider responses can contain request details. Keep logs and Ops cases
      // free of secrets and recipient data while BullMQ handles retry/backoff.
      throw new ServiceUnavailableException(
        "Email delivery was rejected by provider",
      );
    }
  }
}
