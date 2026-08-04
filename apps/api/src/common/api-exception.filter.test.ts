import { BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiErrorCode } from '@visa-compass/shared';
import { ZodError, z } from 'zod';
import { ApiException } from './api-error.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { RateLimitGuard } from './rate-limit.guard.js';

function hostFor(request: Record<string, unknown>) {
  const response: { body?: unknown; statusCode: number; status(code: number): typeof response; json(body: unknown): typeof response; setHeader(name: string, value: string | number): typeof response } = {
    body: undefined,
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    response,
  } as never;
}

describe('ApiExceptionFilter', () => {
  it('never leaks internal detail for 5xx and returns a stable public code', () => {
    const filter = new ApiExceptionFilter();
    const loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const host = hostFor({ correlationId: 'trace-1', method: 'POST', url: '/api/v1/customer/orders' });
    filter.catch(new Error('secret database DSN leaked'), host);
    const body = (host as unknown as { response: { body: { error: { code: string; message: string } } } }).response.body;
    expect(body.error.code).toBe('UNEXPECTED');
    expect(body.error.message).toBe('Something went wrong. Please try again.');
    expect(JSON.stringify(body)).not.toContain('secret database DSN leaked');
    expect(loggerError).toHaveBeenCalled();
  });

  it('exposes the customer-safe message of typed ApiException and logs internal detail', () => {
    const filter = new ApiExceptionFilter();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const host = hostFor({ correlationId: 'trace-2', method: 'GET', url: '/api/v1/customer/orders/x/usage' });
    filter.catch(
      new ApiException({ code: ApiErrorCode.USAGE_UNAVAILABLE, message: 'Usage details are not available yet.', status: 502, details: 'Transatel internal response: 500 boom' }),
      host,
    );
    const body = (host as unknown as { response: { body: { error: { code: string; message: string } } } }).response.body;
    expect(body.error.code).toBe('USAGE_UNAVAILABLE');
    expect(body.error.message).toBe('Usage details are not available yet.');
    expect(JSON.stringify(body)).not.toContain('500 boom');
  });

  it('returns VALIDATION_ERROR details for Zod failures', () => {
    const filter = new ApiExceptionFilter();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const host = hostFor({ correlationId: 'trace-3', method: 'POST', url: '/api/v1/customer/orders' });
    try { z.object({ planId: z.string() }).parse({}); } catch (error) { filter.catch(error as ZodError, host); }
    const body = (host as unknown as { response: { body: { error: { code: string; details: unknown[] } } } }).response.body;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.length).toBe(1);
  });

  it('preserves deliberate 4xx business messages', () => {
    const filter = new ApiExceptionFilter();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const host = hostFor({ correlationId: 'trace-4', method: 'POST', url: '/api/v1/customer/orders' });
    filter.catch(new BadRequestException('Payment reference mismatch'), host);
    const body = (host as unknown as { response: { body: { error: { code: string; message: string } } } }).response.body;
    expect(body.error.message).toBe('Payment reference mismatch');
  });
});

describe('RateLimitGuard', () => {
  it('allows requests within the window and rejects beyond it', () => {
    vi.stubEnv('AUTH_RATE_LIMIT_PER_MINUTE', '2');
    const guard = new RateLimitGuard();
    const request = { ip: '1.2.3.4', method: 'GET', path: '/api/v1/auth/me', headers: {} };
    const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }) } as never;
    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);
    vi.unstubAllEnvs();
  });

  it('exempts webhook endpoints', () => {
    const guard = new RateLimitGuard();
    const request = { ip: '1.2.3.4', method: 'POST', path: '/api/v1/webhooks/connectivity/transatel', headers: {} };
    const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader() {} }) }) } as never;
    for (let i = 0; i < 1000; i++) expect(guard.canActivate(context)).toBe(true);
  });
});
