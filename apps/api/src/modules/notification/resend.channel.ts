import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { EmailSendInput, EmailSendResult } from './email.types.js';

@Injectable()
export class ResendChannel {
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    if (process.env.NOTIFICATION_MODE !== 'live') return { providerMessageId: `resend-sim-${Date.now()}`, simulated: true };
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM_ADDRESS;
    if (!apiKey || !from) {
      if (process.env.NODE_ENV !== 'production') return { providerMessageId: `resend-sim-${Date.now()}`, simulated: true };
      throw new ServiceUnavailableException('Resend delivery is not configured');
    }
    const body: Record<string, unknown> = { from, to: [input.to], subject: input.subject, text: input.text };
    if (input.html) body.html = input.html;
    const replyTo = input.replyTo ?? process.env.EMAIL_REPLY_TO;
    if (replyTo) {
      body.reply_to = replyTo.includes(',') ? replyTo.split(',').map((value) => value.trim()).filter(Boolean) : [replyTo];
    }
    if (input.attachment) {
      body.attachments = [{ filename: input.attachment.filename, content: input.attachment.base64, content_type: input.attachment.contentType }];
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const err = (await response.json()) as { message?: string };
        detail = err?.message?.slice(0, 300) ?? '';
      } catch {
        detail = (await response.text().catch(() => '')).slice(0, 300);
      }
      throw new ServiceUnavailableException(`Resend delivery failed${detail ? `: ${detail}` : ''}`);
    }
    const result = (await response.json()) as { id: string };
    return { providerMessageId: result.id, simulated: false };
  }
}