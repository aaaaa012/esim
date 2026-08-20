export const EMAIL_CHANNEL = Symbol("EMAIL_CHANNEL");

export type EmailAttachment = {
  filename: string;
  contentType: string;
  base64: string;
};

export type EmailSendInput = {
  to: string;
  subject: string;
  text: string;
  attachment?: EmailAttachment;
  idempotencyKey?: string;
};

export type EmailSendResult = {
  providerMessageId: string;
  simulated: boolean;
};

export interface EmailChannel {
  send(input: EmailSendInput): Promise<EmailSendResult>;
}
