import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentStatus } from '@visa-compass/shared';
import type { PaymentContext, PaymentGateway, PaymentInitiation, PaymentVerification } from '../payment-gateway.js';

@Injectable()
export class EsewaGateway implements PaymentGateway {
  readonly provider = 'ESEWA';
  private get baseUrl() { return process.env.ESEWA_INTENT_BASE_URL ?? 'https://rc-checkout.esewa.com.np/api/client/intent/payment'; }
  private get productCode() { return process.env.ESEWA_PRODUCT_CODE ?? 'INTENT'; }
  private get accessKey() { return process.env.ESEWA_ACCESS_KEY; }
  private signature(fields: Record<string,string|number>, names: string[]) { if (!this.accessKey) throw new ServiceUnavailableException('eSewa sandbox access key is not configured'); const message = names.map((name) => `${name}=${fields[name]}`).join(','); return createHmac('sha256', this.accessKey).update(message).digest('base64'); }

  async initiate(input: { orderId: string; orderNumber: string; amountNpr: number; returnUrl: string }): Promise<PaymentInitiation> {
    const names = ['product_code','amount','transaction_uuid'];
    const fields = { product_code: this.productCode, amount: input.amountNpr, transaction_uuid: input.orderId };
    const response = await fetch(`${this.baseUrl}/book`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, signed_field_names: names.join(','), signature: this.signature(fields,names), callback_url: `${process.env.API_PUBLIC_URL ?? 'http://localhost:4000'}/api/v1/webhooks/payments/esewa`, redirect_url: input.returnUrl, properties: { order_number: input.orderNumber } }) });
    const payload = await response.json() as { data?: { booking_id: string; deeplink: string; correlation_id: string }; error_message?: string };
    if (!response.ok || !payload.data) throw new ServiceUnavailableException(payload.error_message ?? 'eSewa payment booking failed');
    return { reference: payload.data.booking_id, correlationId: payload.data.correlation_id, redirectUrl: payload.data.deeplink, expiresAt: new Date(Date.now()+30*60_000).toISOString() };
  }

  async verify(reference: string, context: PaymentContext): Promise<PaymentVerification> {
    if (!context.correlationId) throw new ServiceUnavailableException('Persisted eSewa correlation ID is unavailable');
    const names = ['booking_id','product_code','correlation_id']; const fields = { booking_id: reference, product_code: this.productCode, correlation_id: context.correlationId };
    const response = await fetch(`${this.baseUrl}/status`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ ...fields, signed_field_names:names.join(','), signature:this.signature(fields,names) }) });
    const payload = await response.json() as { data?: { status: string; transaction_id?: string }; error_message?: string };
    if (!response.ok || !payload.data) throw new ServiceUnavailableException(payload.error_message ?? 'eSewa status lookup failed');
    const statuses: Record<string,PaymentStatus> = { SUCCESS:PaymentStatus.COMPLETED, BOOKED:PaymentStatus.PENDING, PENDING:PaymentStatus.PENDING, FAILED:PaymentStatus.FAILED, CANCELED:PaymentStatus.CANCELLED, REVERTED:PaymentStatus.REFUNDED };
    return { reference, orderId:context.orderId, amountNpr:context.amountNpr, status:statuses[payload.data.status] ?? PaymentStatus.PENDING, ...(payload.data.transaction_id?{providerTransactionId:payload.data.transaction_id}:{}) };
  }
}
