import type { PaymentStatus } from "@visa-compass/shared";
export type PaymentInitiation = {
  reference: string;
  redirectUrl: string;
  expiresAt: string;
  correlationId?: string;
  qrDataUrl?: string;
  qrPayload?: string;
  websocketUrl?: string;
  banks?: {
    bankName: string;
    bankCode: string;
    bankIcon?: string;
    packageName?: string;
    intentScheme: string;
  }[];
};
export type PaymentVerification = {
  reference: string;
  providerTransactionId?: string;
  status: PaymentStatus;
  amountNpr: number;
  currency?: string;
  orderId: string;
};
export type PaymentContext = {
  orderId: string;
  amountNpr: number;
  currency?: string;
  correlationId?: string;
  expiresAt?: string;
};
export interface PaymentGateway {
  readonly provider: string;
  initiate(input: {
    attemptId: string;
    orderId: string;
    orderNumber: string;
    amountNpr: number;
    returnUrl: string;
  }): Promise<PaymentInitiation>;
  verify(
    reference: string,
    context: PaymentContext,
  ): Promise<PaymentVerification>;
}
