export type EmailAttachment = {
  filename: string;
  contentType: string;
  base64: string;
};

export type EmailSendInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachment?: EmailAttachment;
  replyTo?: string;
};

export type EmailSendResult = {
  providerMessageId: string;
  simulated: boolean;
};