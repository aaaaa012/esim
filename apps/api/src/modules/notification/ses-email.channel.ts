import {
  SESv2Client,
  SendEmailCommand,
  type Message,
} from "@aws-sdk/client-sesv2";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type {
  EmailChannel,
  EmailSendInput,
  EmailSendResult,
} from "./email.channel.js";

@Injectable()
export class SesEmailChannel implements EmailChannel {
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    if (process.env.NOTIFICATION_MODE !== "live") {
      return {
        providerMessageId: `ses-sim-${Date.now()}`,
        simulated: true,
      };
    }

    const region = process.env.AWS_SES_REGION ?? process.env.AWS_REGION;
    const fromAddress = process.env.EMAIL_FROM_ADDRESS;
    if (process.env.EMAIL_PROVIDER !== "ses" || !region || !fromAddress) {
      throw new ServiceUnavailableException("Email delivery is not configured");
    }

    const message: Message = {
      Subject: { Data: this.cleanHeader(input.subject), Charset: "UTF-8" },
      Body: {
        Text: { Data: input.text, Charset: "UTF-8" },
        ...(input.html
          ? { Html: { Data: input.html, Charset: "UTF-8" } }
          : {}),
      },
      ...(input.attachment
        ? {
            Attachments: [
              {
                FileName: this.cleanHeader(input.attachment.filename),
                ContentType: this.cleanHeader(input.attachment.contentType),
                ContentDisposition: "ATTACHMENT",
                ContentTransferEncoding: "BASE64",
                RawContent: Buffer.from(input.attachment.base64, "base64"),
              },
            ],
          }
        : {}),
    };
    const fromName = process.env.EMAIL_FROM_NAME?.trim();
    const from = fromName
      ? `${this.cleanHeader(fromName)} <${fromAddress}>`
      : fromAddress;

    try {
      const result = await new SESv2Client({ region }).send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [input.to] },
          Content: { Simple: message },
          ...(process.env.EMAIL_REPLY_TO
            ? { ReplyToAddresses: [process.env.EMAIL_REPLY_TO] }
            : {}),
          ...(process.env.AWS_SES_CONFIGURATION_SET
            ? {
                ConfigurationSetName:
                  process.env.AWS_SES_CONFIGURATION_SET,
              }
            : {}),
        }),
      );
      if (!result.MessageId) throw new Error("provider rejected the message");
      return { providerMessageId: result.MessageId, simulated: false };
    } catch {
      throw new ServiceUnavailableException(
        "Email delivery was rejected by provider",
      );
    }
  }

  private cleanHeader(value: string) {
    return value.replace(/[\r\n]+/g, " ").trim();
  }
}
