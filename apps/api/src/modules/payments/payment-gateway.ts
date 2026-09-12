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

export const PaymentCapability = {
  QR_CHECKOUT: "QR_CHECKOUT",
  REDIRECT_CHECKOUT: "REDIRECT_CHECKOUT",
  STATUS_LOOKUP: "STATUS_LOOKUP",
  BANK_DIRECTORY: "BANK_DIRECTORY",
  PROVIDER_WEBSOCKET: "PROVIDER_WEBSOCKET",
  AUTOMATED_REFUND: "AUTOMATED_REFUND",
  MANUAL_REFUND_GUIDANCE: "MANUAL_REFUND_GUIDANCE",
  DISPUTE_WEBHOOK: "DISPUTE_WEBHOOK",
} as const;
export type PaymentCapability =
  (typeof PaymentCapability)[keyof typeof PaymentCapability];

/**
 * Declared financial capabilities of a gateway. Ops surfaces these verbatim so
 * that unsupported capabilities (for example refunds or dispute ingestion) are
 * visible in Operations rather than silently implied by the provider's brand.
 */
export type GatewayCapabilities = {
  checkout: "QR" | "REDIRECT" | "QR_AND_REDIRECT" | "NONE";
  statusLookup: boolean;
  refunds: "SUPPORTED" | "MANUAL" | "NOT_SUPPORTED";
  disputes: "SUPPORTED" | "NOT_SUPPORTED";
  extra?: PaymentCapability[];
};

export interface PaymentGateway {
  readonly provider: string;
  /**
   * Declares what this gateway can do today. Used to keep Operations informed
   * of provider-specific financial gaps (for example Fonepay's manual-only
   * refunds) instead of implying full parity with other providers.
   */
  capabilities(): GatewayCapabilities;
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
