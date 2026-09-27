# 15 — Webhooks and Integration Events

Primary source: `apps/api/src/modules/webhooks/webhooks.controller.ts`.

## Overview

Three inbound webhook families are accepted, all returning HTTP 202, all
exempt from rate limiting (`rate-limit.guard.ts:30`). Signature verification
is documented in `docs/05-authentication-authorization.md`.

## Endpoints

### `POST /webhooks/clerk`

`webhooks.controller.ts:18-32`:

- If `CLERK_WEBHOOK_SECRET` unset: in production → 400; otherwise returns
  `{ accepted: true, simulated: true }`.
- Verifies with Svix (`svix-id`, `svix-timestamp`, `svix-signature` headers).
- Calls `clerkSync.sync(event)` and returns
  `{ accepted: true, eventType, userId, ...result }`.
- Events handled: `user.created`, `user.updated`, `user.deleted`
  (`clerk-sync.service.ts:26-27`).

### `POST /webhooks/payments/:provider`

`webhooks.controller.ts`:

- Only Khalti is accepted. Body requires `eventId` and supports payment
  reference/order fields plus dispute event/case evidence.
- Requires `x-visa-signature` HMAC-SHA256 over the exact raw request body.
- Deduplicates via a durable `WebhookEvent` inbox row (returns
  `{ accepted: true, duplicate: true }`).
- Persists the webhook event then enqueues
  `payments:payment-callback { provider, eventId, payload }`.
- Persisted but unprocessed duplicate delivery is re-enqueued; the independent
  reconciliation process also sweeps abandoned inbox rows.
- Returns `{ accepted: true, queued: true }`.

### `POST /webhooks/connectivity/:provider`

`webhooks.controller.ts:47-62`:

- Only `provider === 'transatel'` is accepted (else 400).
- `eventId` from `body.eventId ?? body.header?.eventId`.
- Signature from `x-tsl-signature-256` or `x-visa-signature`:
  - If present, verified against `TRANSATEL_WEBHOOK_SECRET` (format
    `sha256=<hex>`).
  - If absent in production → 400 ("Transatel webhook signature is required").
- Dedup + persist + enqueue `providerCallbacks:connectivity-callback`.

### `GET /operations/integration-events`

`webhooks.controller.ts:79-85` — OPERATIONS/SUPER_ADMIN. Returns up to 200
`WebhookEvent` rows (id, source, eventId, signatureValid, processedAt,
errorMessage, createdAt), excluding sources starting with `idempotency:`.

### `GET /operations/integration-logs`

`webhooks.controller.ts:87-93` — OPERATIONS/SUPER_ADMIN. Returns up to 200
`IntegrationLog` rows, optionally filtered by `?operation=`.

## Persistence helpers

- `persistWebhook(source, eventId, payload, signatureValid)` — upserts a
  `WebhookEvent` on `(source, eventId)` when Prisma enabled
  (`webhooks.controller.ts:64-67`).
- `webhookExists(source, eventId)` — dedupe check (`webhooks.controller.ts:69`).

## Signature verification details

- `verifyLocalSignature` (`webhooks.controller.ts:71-75`): HMAC-SHA256 of the
  raw JSON body with `PAYMENT_SIMULATOR_SECRET`; constant-time compare.
- `verifyTransatelSignature` (`webhooks.controller.ts:76`): expected
  `sha256={HMAC-SHA256(TRANSATEL_WEBHOOK_SECRET, body)}`; constant-time
  compare against the header value.

## Processing pipeline

Webhook events are processed by `IntegrationProcessor`
(`jobs/integration.processor.ts:20-26`):

- **payment** job → `payments.verifyCallback(orderId, reference)`.
- **connectivity** job → `connectivityService.handleWebhook(payload)` then,
  when handled and an event is present, `orders.applyProviderEvent(event)`.
- `complete()` sets `processedAt` and `errorMessage` on the `WebhookEvent`
  row.

## Transatel datastream configuration

Transatel no longer accepts webhook subscriptions through its API. Configure
the callback URL, shared secret and required lifecycle events as a datastream
in the Transatel Developer Console. The application receives, authenticates,
deduplicates and processes those callbacks.

## Idempotency note

The idempotency interceptor stores its bookkeeping in the same `WebhookEvent`
table under sources prefixed `idempotency:`; those rows are excluded from the
`/operations/integration-events` listing (`webhooks.controller.ts:84`).
