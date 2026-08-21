import { Injectable } from '@nestjs/common';
import { GmailChannel } from './gmail.channel.js';
import { ResendChannel } from './resend.channel.js';
import type { EmailSendInput, EmailSendResult } from './email.types.js';

/**
 * Provider-selecting email channel. EMAIL_PROVIDER selects the transport:
 *   - "gmail"  -> Gmail API (OAuth refresh token)
 *   - "resend" -> Resend REST API (verified sender + API key)
 * Defaults to Gmail so existing deployments keep working until EMAIL_PROVIDER
 * is set. The selected provider is resolved per-send, keeping the switchable
 * at runtime without a restart.
 */
@Injectable()
export class EmailChannel {
  constructor(
    private readonly gmail: GmailChannel,
    private readonly resend: ResendChannel,
  ) {}

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    return (process.env.EMAIL_PROVIDER === 'resend' ? this.resend : this.gmail).send(input);
  }
}