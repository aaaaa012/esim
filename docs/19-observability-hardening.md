# 19 — Observability and Hardening

Primary sources: `apps/api/src/main.ts`, `common/{correlation,logging,idempotency}.interceptor.ts`,
`common/rate-limit.guard.ts`, `common/api-exception.filter.ts`,
`common/api-error.ts`, `observability/health.controller.ts`.

## Bootstrapping (`main.ts`)

- `helmet()` (`:16`); CORS restricted to `CUSTOMER_WEB_URL` / `OPS_WEB_URL`
  defaults `http://localhost:3000` / `http://localhost:3001` with credentials
  (`:17`).
- Global prefix `api/v1` (`:18`); `ValidationPipe({ whitelist: true,
transform: true })` (`:19`).
- Global filter `ApiExceptionFilter`; guard `RateLimitGuard`; interceptors
  `CorrelationInterceptor → LoggingInterceptor → IdempotencyInterceptor`
  (`:20-22`).
- Swagger at `/api/docs` with bearer auth (`:23-24`); port
  `process.env.PORT ?? 4000` (`:25`).

## Response envelope

Every success response is wrapped by `CorrelationInterceptor` as
`{ data, meta: { correlationId, timestamp } }` (`correlation.interceptor.ts:13`).
Failures are wrapped by `ApiExceptionFilter` as
`{ data: null, error: { code, message, details? }, meta }`
(`api-exception.filter.ts:97-109`).

## Correlation

- `x-correlation-id` request header is honored; otherwise a fresh `uuid` is
  generated (`correlation.interceptor.ts:10`).
- Echoed back in the `x-correlation-id` response header and in every
  `meta.correlationId`; failures log it so support can trace a 5xx
  (`api-exception.filter.ts:83-90`).

## Error mapping (`api-exception.filter.ts`)

Order of precedence:

1. `ZodError` → 400 `VALIDATION_ERROR` with `details: [{ field, message }]`
   (`:35-53`).
2. `ApiException` → its `status`/`code`/`message`; `internalDetail` logged but
   never sent (`:54-58`).
3. Other `HttpException` → status; `code` from body or `HTTP_{status}`;
   message joins arrays (`:59-74`).
4. Anything else → 500 `UNEXPECTED` with the generic shared message
   (`:75-80`).

Server detail is logged with the stack; 5xx responses never leak internals
(`:82-95`). `ApiException` (`api-error.ts`) carries `code` + customer-safe
`message` + internal `details` separately.

## Rate limiting (`rate-limit.guard.ts`)

- Redis-backed fixed-window buckets are keyed by normalized
  `ip:method:path`. During a short Redis outage the guard opens a five-second
  circuit and falls back to a stricter per-process token bucket so checkout
  remains available without silently restoring the full allowance.
- Webhook paths are exempt (`:30`); `/auth` and `/public` use
  `AUTH_RATE_LIMIT_PER_MINUTE` (default 60), everything else
  `RATE_LIMIT_PER_MINUTE` (default 300) (`:18-19,32-33`).
- Responds with `x-ratelimit-limit`, `x-ratelimit-remaining`, and on reject
  `retry-after` + 429 `RATE_LIMITED` (`:46-53`).
- Local fallback buckets are reaped when the map exceeds 10,000 entries.
- Multi-instance deployments use the shared Redis store; degraded/recovered
  transitions are surfaced through the rate-limit incident service.
  `docs/20-documentation-gaps.md`).

## Request logging (`logging.interceptor.ts`)

Every completed request logs `method url status durationMs correlationId
actor`; actor is `accountType:masked-id` or `anonymous`; ids are masked
(`:20-21,28-31`). Failures are additionally logged by the exception filter.

## Idempotency (`idempotency.interceptor.ts`)

- Only `POST/PATCH/PUT/DELETE`, non-webhook, when Prisma is enabled, and only
  when the caller sends `x-idempotency-key` (8–200 chars) (`:11-14`).
- Stores replay responses in the `WebhookEvent` table under
  `source = idempotency:{method}:{path}:{user|anonymous}` and hashes the body
  to detect conflicting reuse (`:15-19`). See `docs/15` for exclusion from the
  integration-events listing.
- If Prisma is disabled (no `DATABASE_URL`) idempotency is skipped (`:11`).

## Health

- `GET /api/v1/health/live` → `{ status: 'ok' }` (`health.controller.ts:7`).
- `GET /api/v1/health/ready` → performs `SELECT 1` when Prisma enabled, reports
  `api`, `database` (up / not-configured / down), `databaseLatencyMs`, and
  `redis` = configured / not-configured based on `REDIS_URL`; status
  `ready` | `degraded` (`:8-32`).

## Audit trail

Order lifecycle transitions are recorded immutably in the `AuditEvent` table
via `orders.service.ts` `audit()` helper (module/orderNumber/previous/action/
reason), exposed at `GET /operations/audit` and shown in the ops portal
(`docs/04`, `docs/18`).
