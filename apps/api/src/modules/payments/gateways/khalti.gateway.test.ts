import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KhaltiGateway } from './khalti.gateway.js';
import { ApiException } from '../../../common/api-error.js';

const prismaStub = { enabled: false, integrationLog: { create: vi.fn() } } as never;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('KhaltiGateway', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.KHALTI_SECRET_KEY = 'test-secret-key';
    process.env.KHALTI_BASE_URL = 'https://khalti.example.com/api/v2';
    delete process.env.KHALTI_REQUEST_TIMEOUT_MS;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('refuses to initiate when the secret key is missing', async () => {
    delete process.env.KHALTI_SECRET_KEY;
    const gateway = new KhaltiGateway(prismaStub);
    const error = await gateway.initiate({ orderId: 'o1', orderNumber: 'VC-1', amountNpr: 500, returnUrl: 'https://x/return' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect(error.getStatus()).toBe(503);
  });

  it('initiates with paisa amounts and returns the redirect contract', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return jsonResponse(200, { pidx: 'pidx-1', payment_url: 'https://pay.khalti/pidx-1' });
    }) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(prismaStub);
    const result = await gateway.initiate({ orderId: 'order-9', orderNumber: 'VC-2026-X', amountNpr: 12.5, returnUrl: 'https://shop.example/esim/checkout?step=4' });
    expect(result.reference).toBe('pidx-1');
    expect(result.redirectUrl).toBe('https://pay.khalti/pidx-1');
    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.amount).toBe(1250);
    expect(parsed.purchase_order_id).toBe('order-9');
    expect(new URL(parsed.website_url as string).origin).toBe('https://shop.example');
  });

  it('maps lookup statuses to payment verdicts case-insensitively', async () => {
    const cases: Array<[string, string]> = [
      ['Completed', 'COMPLETED'],
      ['completed', 'COMPLETED'],
      ['Pending', 'PENDING'],
      ['Initiated', 'PENDING'],
      ['Expired', 'FAILED'],
      ['User canceled', 'CANCELLED'],
      ['Refunded', 'REFUNDED'],
      ['Partially refunded', 'REFUNDED'],
    ];
    for (const [providerStatus, expected] of cases) {
      globalThis.fetch = vi.fn(async () => jsonResponse(200, { status: providerStatus, total_amount: 50000, transaction_id: 'tx-1' })) as unknown as typeof fetch;
      const gateway = new KhaltiGateway(prismaStub);
      const result = await gateway.verify('pidx-1', { orderId: 'o1', amountNpr: 500 });
      expect(result.status).toBe(expected);
      if (expected === 'COMPLETED') {
        expect(result.amountNpr).toBe(500);
        expect(result.providerTransactionId).toBe('tx-1');
      }
    }
  });

  it('treats an unknown lookup status as failed rather than success', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, { status: 'MysteryState' })) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(prismaStub);
    const result = await gateway.verify('pidx-1', { orderId: 'o1', amountNpr: 500 });
    expect(result.status).toBe('FAILED');
  });

  it('never invents an amount when a completed lookup omits total_amount', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, { status: 'Completed' })) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(prismaStub);
    const result = await gateway.verify('pidx-1', { orderId: 'o1', amountNpr: 500 });
    expect(Number.isNaN(result.amountNpr)).toBe(true);
  });

  it('surfaces provider HTTP failures as PAYMENT_PROVIDER_ERROR with safe client messaging', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(400, { detail: 'pidx invalid', error_key: 'validation_error' })) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(prismaStub);
    const error = await gateway.verify('bad', { orderId: 'o1', amountNpr: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect(error.getStatus()).toBe(502);
    expect(error.message).not.toContain('pidx invalid');
    expect(error.internalDetail).toContain('pidx invalid');
  });

  it('maps network-layer failures to PAYMENT_PROVIDER_ERROR instead of a generic 500', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(prismaStub);
    const error = await gateway.initiate({ orderId: 'o1', orderNumber: 'VC-1', amountNpr: 5, returnUrl: 'https://x/r' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect(error.getStatus()).toBe(502);
    expect(error.internalDetail).toContain('ENOTFOUND');
  });

  it('rejects a non-JSON initiation response instead of trusting it', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, '<html>gateway error</html>')) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(prismaStub);
    const error = await gateway.initiate({ orderId: 'o1', orderNumber: 'VC-1', amountNpr: 5, returnUrl: 'https://x/r' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect(error.getStatus()).toBe(502);
    expect(error.internalDetail).toContain('non-JSON');
  });

  it('rejects an initiation payload without pidx or payment_url', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, { detail: 'ok but empty' })) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(prismaStub);
    const error = await gateway.initiate({ orderId: 'o1', orderNumber: 'VC-1', amountNpr: 5, returnUrl: 'https://x/r' }).catch((e) => e);
    expect(error.getStatus()).toBe(502);
    expect(error.internalDetail).toContain('missing pidx');
  });

  it('keeps working when the integration log sink is unavailable', async () => {
    const failingPrisma = { enabled: true, integrationLog: { create: vi.fn().mockRejectedValue(new Error('db down')) } } as never;
    globalThis.fetch = vi.fn(async () => jsonResponse(200, { pidx: 'p', payment_url: 'https://pay/p' })) as unknown as typeof fetch;
    const gateway = new KhaltiGateway(failingPrisma);
    const result = await gateway.initiate({ orderId: 'o1', orderNumber: 'VC-1', amountNpr: 5, returnUrl: 'https://x/r' });
    expect(result.reference).toBe('p');
  });
});
