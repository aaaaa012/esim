import { Prisma } from "@prisma/client";

const RETRYABLE_DATABASE_CODES = new Set(["P2034", "40001", "40P01"]);

function isRetryableDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return RETRYABLE_DATABASE_CODES.has(error.code);
  }
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return RETRYABLE_DATABASE_CODES.has(code);
}

export async function withPostgresTransactionRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 40;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableDatabaseError(error) || attempt === attempts) throw error;
      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) =>
        setTimeout(resolve, exponentialDelay + jitter),
      );
    }
  }

  throw lastError;
}
