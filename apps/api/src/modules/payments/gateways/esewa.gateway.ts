import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ApiErrorCode, PaymentStatus } from '@visa-compass/shared';
import { ApiException } from '../../../common/api-error.js';
import type { PaymentContext, PaymentGateway, PaymentInitiation, PaymentVerification } from '../payment-gateway.js';

/**
 * eSewa Payment Gateway (Intent API) adapter.
 *
 * Wire contract (developer.esewa.com.np):
 * - Authentication is a shared-secret HMAC-SHA256 `signature` over an
 *   ordered subset of fields (`signed_field_names`).
 * - Amounts are in NPR (integer); no paisa conversion required.
 * - The `data.booking_id` becomes our payment `reference`, and the
 *   `correlation_id` must be persisted and resubmitted on status lookup.
 * - Callback delivery points at the shared webhook
 *   `/api/v1/webhooks/payments/esewa`, mirroring the Khalti callback flow.
 *
 * Provider failures are surfaced as `ApiException` with code
 * `PAYMENT_PROVIDER_ERROR`; the provider detail is kept in `details`
 * (logged server-side, never serialized to clients).
 */
@Injectable()
export class EsewaGateway implements PaymentGateway {
  readonly provider = 'ESEWA';

  private get baseUrl(): string {
    return (process.env.ESEWA_INTENT_BASE_URL ?? 'https://rc-checkout.esewa.com.np/api/client/intent/payment').replace(/\/+$/, '');
  }

  private get accessKey(): string {
    return process.env.ESEWA_ACCESS_KEY ?? '';
  }

  private get productCode(): string {
    return process.env.ESEWA_PRODUCT_CODE ?? 'INTENT';
  }

  private timeoutMs(): number {
    const parsed = Number(process.env.ESEWA_REQUEST_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
  }

  private ensureConfigured(): void {
    if (!this.accessKey)
      throw new ApiException({
        code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
        message: 'The payment provider is not fully configured. Please contact support.',
        status: 503,
        details: 'ESEWA_ACCESS_KEY is not configured',
      });
  }

  private signature(fields: Record<string, string | number>, names: string[]): string {
    this.ensureConfigured();
    const message = names.map((name) => `${name}=${fields[name]}`).join(',');
    return createHmac('sha256', this.accessKey).update(message).digest('base64');
  }

  /** Wraps the raw `fetch` so transport failures (network down, DNS, timeout)
   *  surface as the payment-specific `PAYMENT_PROVIDER_ERROR` (502) instead of a
   *  generic 500. The underlying message is kept in `details` (logged
   *  server-side, never shown to customers). */
  private async request(url: string, init: RequestInit, operation: string): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ApiException({
        code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
        message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
        status: 502,
        details: `eSewa ${operation} failed on the network layer: ${detail}`,
      });
    }
  }

  private providerError(operation: string, response: Response, detail: string): ApiException {
    return new ApiException({
      code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
      message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
      status: 502,
      details: `eSewa ${operation} failed with status ${response.status}: ${detail.slice(0, 2000)}`,
    });
  }

  private async providerDetail(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as { error_message?: string } | Record<string, unknown>;
      if ('error_message' in data && typeof data.error_message === 'string' && data.error_message) return data.error_message;
      return JSON.stringify(data);
    } catch {
      return response.text();
    }
  }

  async initiate(input: { orderId: string; orderNumber: string; amountNpr: number; returnUrl: string }): Promise<PaymentInitiation> {
    const names = ['product_code', 'amount', 'transaction_uuid'];
    const fields = { product_code: this.productCode, amount: input.amountNpr, transaction_uuid: input.orderId };
    const response = await this.request(
      `${this.baseUrl}/book`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          signed_field_names: names.join(','),
          signature: this.signature(fields, names),
          callback_url: `${process.env.API_PUBLIC_URL ?? 'http://localhost:4000'}/api/v1/webhooks/payments/esewa`,
          redirect_url: input.returnUrl,
          properties: { order_number: input.orderNumber },
        }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
      'initiation',
    );
    let payload: { data?: { booking_id?: string; deeplink?: string; correlation_id?: string }; error_message?: string };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      throw new ApiException({
        code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
        message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
        status: 502,
        details: `eSewa initiation returned a non-JSON response: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!response.ok || !payload.data?.booking_id || !payload.data.deeplink || !payload.data.correlation_id)
      throw this.providerError('initiation', response, payload.error_message ?? JSON.stringify(payload));
    return {
      reference: payload.data.booking_id,
      correlationId: payload.data.correlation_id,
      redirectUrl: payload.data.deeplink,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }

  async verify(reference: string, context: PaymentContext): Promise<PaymentVerification> {
    if (!context.correlationId)
      throw new ApiException({
        code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
        message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
        status: 502,
        details: 'Persisted eSewa correlation ID is unavailable',
      });
    const names = ['booking_id', 'product_code', 'correlation_id'];
    const fields = { booking_id: reference, product_code: this.productCode, correlation_id: context.correlationId };
    const response = await this.request(
      `${this.baseUrl}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          signed_field_names: names.join(','),
          signature: this.signature(fields, names),
        }),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
      'lookup',
    );
    let payload: { status?: { status?: string; transaction_id?: string }; data?: { status?: string; transaction_id?: string }; error_message?: string };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    const providerStatus = payload.data?.status ?? payload.status?.status;
    if (typeof providerStatus === 'string' && providerStatus) {
      const statuses: Record<string, PaymentStatus> = {
        SUCCESS: PaymentStatus.COMPLETED,
        BOOKED: PaymentStatus.PENDING,
        PENDING: PaymentStatus.PENDING,
        FAILED: PaymentStatus.FAILED,
        CANCELED: PaymentStatus.CANCELLED,
        REVERTED: PaymentStatus.REFUNDED,
      };
      return {
        reference,
        status: statuses[providerStatus.toUpperCase()] ?? PaymentStatus.PENDING,
        amountNpr: context.amountNpr,
        orderId: context.orderId,
        ...(payload.data?.transaction_id ? { providerTransactionId: payload.data.transaction_id } : {}),
      };
    }
    if (!response.ok) throw this.providerError('lookup', response, await this.providerDetail(response));
    throw new ApiException({
      code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
      message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
      status: 502,
      details: `eSewa lookup response did not include a payment status: ${JSON.stringify(payload)}`,
    });
  }

  /**
   * eSewa does not offer a wallet-initiated refund HTTP API used for the
   * merchant-to-consumer refund flow here; refunds are processed manually on
   * the eSewa merchant dashboard. Marking the reference so downstream ledger
   * and order state remain consistent.
   */
  async refund(reference: string, _context: PaymentContext, _amountNpr: number): Promise<{ reference: string }> {
    return { reference: `refund-${reference}` };
  }
}