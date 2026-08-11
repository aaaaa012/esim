import { describe, expect, it, vi } from 'vitest';
import { classifyProviderHttpFailure } from './provider-failure.js';

describe('classifyProviderHttpFailure', () => {
  it('classifies permanent client errors without retry', () => expect(classifyProviderHttpFailure(422)).toEqual({ category: 'PERMANENT_INPUT', retryable: false, ambiguous: false }));
  it('classifies provider failures as retryable', () => expect(classifyProviderHttpFailure(503)).toEqual({ category: 'TRANSIENT_PROVIDER', retryable: true, ambiguous: false }));
  it('honors Retry-After for rate limiting', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    expect(classifyProviderHttpFailure(429, '12')).toEqual({ category: 'RATE_LIMITED', retryable: true, ambiguous: false, retryAfterMs: 12_000 });
  });
});
