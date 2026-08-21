import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiErrorCode, PaymentStatus } from '@visa-compass/shared';
import { ApiException } from '../../../common/api-error.js';
import { PrismaService } from '../../../infrastructure/prisma.service.js';
import type { PaymentContext, PaymentGateway, PaymentInitiation, PaymentVerification } from '../payment-gateway.js';

/**
 * Khalti ePayment (Web Checkout / KPG-2) adapter.
 *
 * Wire contract (docs.khalti.com/khalti-epayment):
 * - Authorization: `Key {KHALTI_SECRET_KEY}`.
 * - Amounts are in paisa (NPR * 100).
 * - Only the lookup status `Completed` must be treated as success.
 *
 * Provider failures are surfaced as `ApiException` with code
 * `PAYMENT_PROVIDER_ERROR`; the provider `detail`/`error_key`/field messages
 * are kept in `details` (logged server-side, never serialized to clients).
 *
 * Every outgoing call (request + response bodies) is persisted to the
 * IntegrationLog so the operations team can inspect it from the Logs page.
 * The secret Authorization header is never stored.
 */
@Injectable()
export class KhaltiGateway implements PaymentGateway {
  readonly provider = 'KHALTI';
  private readonly log = new Logger('KhaltiGateway');

  constructor(private readonly prisma: PrismaService) {}

  private get baseUrl(): string {
    return (process.env.KHALTI_BASE_URL ?? 'https://dev.khalti.com/api/v2').replace(/\/+$/, '');
  }

  private get secret(): string {
    return process.env.KHALTI_SECRET_KEY ?? '';
  }

  private timeoutMs(): number {
    const parsed = Number(process.env.KHALTI_REQUEST_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
  }

  private ensureConfigured(): void {
    if (!this.secret)
      throw new ApiException({
        code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
        message: 'The payment provider is not fully configured. Please contact support.',
        status: 503,
        details: 'KHALTI_SECRET_KEY is not configured',
      });
  }

  /** Reads a response body exactly once; empty string when the body is unreadable. */
  private async bodyText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  /** Extracts Khalti's `detail` or per-field validation errors from an already-read body. */
  private providerDetail(raw: string): string {
    if (!raw) return "";
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.detail === 'string' && data.detail) return data.detail;
      const fields = Object.entries(data)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => `${key}: ${(value as string[]).join('; ')}`);
      if (fields.length) return fields.join('; ');
      return raw;
    } catch {
      return raw;
    }
  }

  private providerError(operation: string, response: Response, detail: string): ApiException {
    return new ApiException({
      code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
      message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
      status: 502,
      details: `Khalti ${operation} failed with status ${response.status}: ${detail.slice(0, 2000)}`,
    });
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
        details: `Khalti ${operation} failed on the network layer: ${detail}`,
      });
    }
  }

  private async post(path: string, body: Record<string, unknown>, operation: string): Promise<Response> {
    this.ensureConfigured();
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    const response = await this.request(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Key ${this.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs()),
      },
      operation,
    );
    let raw = '';
    try { raw = await response.clone().text(); } catch { /* body unreadable */ }
    const responseBody = this.parseCapture(raw);
    const requestBody = this.parseCapture(JSON.stringify(body));
    const duration = Date.now() - startedAt;
    await this.persist(operation, url, response.status, duration, requestBody, responseBody).catch(() => undefined);
    return response;
  }

  private parseCapture(value?: string): unknown {
    if (!value || !value.trim()) return undefined;
    try { return JSON.parse(value) as unknown; } catch { return value.length > 12000 ? `${value.slice(0, 12000)}… (truncated)` : value; }
  }

  private async persist(operation: string, url: string, status: number, durationMs: number, requestBody?: unknown, responseBody?: unknown) {
    if (!this.prisma.enabled) return;
    let path: string;
    try { const parsed = new URL(url); path = `${parsed.pathname}${parsed.search}`; } catch { path = url; }
    try {
      await this.prisma.integrationLog.create({
        data: {
          operation: `khalti-${operation}`,
          method: 'POST',
          endpoint: path,
          status,
          durationMs,
          ...(requestBody !== undefined ? { requestBody: requestBody as Prisma.InputJsonValue } : {}),
          ...(responseBody !== undefined ? { responseBody: responseBody as Prisma.InputJsonValue } : {}),
        },
      });
    } catch (error) {
      this.log.error(`Failed to persist Khalti integration log for ${operation}`, error);
    }
  }

  async initiate(input: { orderId: string; orderNumber: string; amountNpr: number; returnUrl: string }): Promise<PaymentInitiation> {
    const response = await this.post('/epayment/initiate/', {
      return_url: input.returnUrl,
      website_url: new URL(input.returnUrl).origin,
      amount: Math.round(input.amountNpr * 100),
      purchase_order_id: input.orderId,
      purchase_order_name: input.orderNumber,
    }, 'initiation');
    const raw = await this.bodyText(response);
    if (!response.ok) throw this.providerError('initiation', response, this.providerDetail(raw));
    let data: { pidx?: string; payment_url?: string; expires_at?: string };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      throw new ApiException({
        code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
        message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
        status: 502,
        details: 'Khalti initiation returned a non-JSON response',
      });
    }
    if (!data.pidx || !data.payment_url)
      throw new ApiException({
        code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
        message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
        status: 502,
        details: `Khalti initiation response is missing pidx/payment_url: ${JSON.stringify(data)}`,
      });
    return {
      reference: data.pidx,
      redirectUrl: data.payment_url,
      expiresAt: data.expires_at ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    };
  }

  async verify(reference: string, context: PaymentContext): Promise<PaymentVerification> {
    const response = await this.post('/epayment/lookup/', { pidx: reference }, 'lookup');
    const raw = await this.bodyText(response);
    let data: { status?: string; total_amount?: number; transaction_id?: string };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      data = {};
    }
    // Khalti returns a body `status` even for 400 outcomes (Expired, User canceled);
    // map it before treating any HTTP status as an error. The lookup status is
    // compared case-insensitively (docs use both "Partially Refunded" and
    // "Partially refunded").
    if (typeof data.status === 'string' && data.status) {
      const statuses: Record<string, PaymentStatus> = {
        completed: PaymentStatus.COMPLETED,
        pending: PaymentStatus.PENDING,
        initiated: PaymentStatus.PENDING,
        refunded: PaymentStatus.REFUNDED,
        'partially refunded': PaymentStatus.REFUNDED,
        expired: PaymentStatus.FAILED,
        'user canceled': PaymentStatus.CANCELLED,
      };
      return {
        reference,
        status: statuses[data.status.toLowerCase()] ?? PaymentStatus.FAILED,
        // A completed lookup without an amount is not verifiable. Never
        // substitute our expected amount: that turns a missing provider field
        // into a false successful amount check.
        amountNpr: typeof data.total_amount === 'number' ? data.total_amount / 100 : Number.NaN,
        orderId: context.orderId,
        ...(data.transaction_id ? { providerTransactionId: data.transaction_id } : {}),
      };
    }
    if (!response.ok) throw this.providerError('lookup', response, this.providerDetail(raw));
    throw new ApiException({
      code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
      message: 'The payment provider is temporarily unavailable. Please try again or use another method.',
      status: 502,
      details: `Khalti lookup response did not include a payment status: ${JSON.stringify(data)}`,
    });
  }

}
