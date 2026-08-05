import type { PaymentStatus } from '@visa-compass/shared';
export type PaymentInitiation = { reference: string; redirectUrl: string; expiresAt: string; correlationId?:string };
export type PaymentVerification = { reference: string; providerTransactionId?: string; status: PaymentStatus; amountNpr: number; orderId: string };
export type PaymentContext={orderId:string;amountNpr:number;correlationId?:string};
export interface PaymentGateway { readonly provider: string; initiate(input: { orderId: string; orderNumber: string; amountNpr: number; returnUrl: string }): Promise<PaymentInitiation>; verify(reference: string,context:PaymentContext): Promise<PaymentVerification>; refund?(reference: string, context: PaymentContext, amountNpr: number): Promise<{ reference: string }>; }
