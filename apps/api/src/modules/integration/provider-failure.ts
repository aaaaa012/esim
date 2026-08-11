export type ProviderFailureCategory =
  | 'PERMANENT_INPUT'
  | 'PERMANENT_ELIGIBILITY'
  | 'AUTHENTICATION'
  | 'RATE_LIMITED'
  | 'TRANSIENT_PROVIDER'
  | 'NETWORK_BEFORE_SEND'
  | 'AMBIGUOUS_OUTCOME'
  | 'ASYNC_PENDING'
  | 'CONTRACT_VIOLATION';

export type ProviderFailure = {
  category: ProviderFailureCategory;
  retryable: boolean;
  ambiguous: boolean;
  retryAfterMs?: number;
};

export function classifyProviderHttpFailure(status: number, retryAfter?: string | null): ProviderFailure {
  if (status === 401 || status === 403) return { category: 'AUTHENTICATION', retryable: status === 401, ambiguous: false };
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(retryAfter);
    return { category: 'RATE_LIMITED', retryable: true, ambiguous: false, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (status >= 500) return { category: 'TRANSIENT_PROVIDER', retryable: true, ambiguous: false };
  return { category: 'PERMANENT_INPUT', retryable: false, ambiguous: false };
}

function parseRetryAfter(value?: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
