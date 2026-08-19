import { afterEach, describe, expect, it, vi } from 'vitest';
import { KhaltiGateway } from './khalti.gateway.js';

describe('KhaltiGateway diagnostics', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KHALTI_SECRET_KEY;
  const originalBase = process.env.KHALTI_BASE_URL;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KHALTI_SECRET_KEY;
    else process.env.KHALTI_SECRET_KEY = originalKey;
    if (originalBase === undefined) delete process.env.KHALTI_BASE_URL;
    else process.env.KHALTI_BASE_URL = originalBase;
    vi.restoreAllMocks();
  });

  it('treats an authenticated validation response as healthy', async () => {
    process.env.KHALTI_SECRET_KEY = 'sandbox-secret';
    process.env.KHALTI_BASE_URL = 'https://dev.khalti.com/api/v2';
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: 'Not found.', error_key: 'validation_error' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));

    await expect(new KhaltiGateway().diagnose()).resolves.toMatchObject({
      healthy: true,
      environment: 'sandbox',
      providerStatus: 400,
    });
  });

  it('rejects an invalid credential response', async () => {
    process.env.KHALTI_SECRET_KEY = 'wrong-secret';
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: 'Invalid token.', status_code: 401 }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));

    await expect(new KhaltiGateway().diagnose()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_PROVIDER_ERROR' }),
    });
  });
});
