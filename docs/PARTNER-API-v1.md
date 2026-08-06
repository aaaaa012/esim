# Visa Compass Partner API v1

Base URL: `/api/v1/partners`

## Authentication and reliability

- Send `x-partner-api-key` on every request. Visa Compass stores only its SHA-256 hash in `PARTNER_API_KEYS_JSON`.
- Send `x-idempotency-key` on every mutation. Reusing a key with a different body returns `409`.
- Responses use the standard `data`, `meta`, and `error` envelope with a correlation ID.
- A partner can read or mutate only orders created by that partner key.
- Errors use stable machine-readable `error.code` values (see `packages/shared/src/errors.ts`) plus a customer-safe `message`. Internal detail is never returned; 5xx responses include the correlation ID for support tracing.
- Requests are rate-limited per IP + route (`x-ratelimit-limit` / `x-ratelimit-remaining` response headers).

## Discovery and sales

- `GET /capabilities` — enabled payments, notifications, selected connectivity provider, health and capabilities.
- `GET /plans` — active public plans without wholesale cost.
- `POST /quotes` — immutable NPR quote valid for 15 minutes. Body: `{ "planId": "uuid" }`.
- `POST /orders` — create a partner order. Body: `{ "planId": "uuid", "externalCustomerId": "...", "compatibilityAccepted": true }`.
- `GET /orders/:id` — normalized status, documents, payment and timeline.

## Traveller and private documents

- `POST /orders/:id/traveler` — validated Transatel-compatible traveller fields.
- `POST /orders/:id/documents` — create a short-lived signed private upload authorization.
- Upload bytes directly to the returned Cloudinary endpoint.
- `POST /orders/:id/documents/:documentId/confirm` — server-verifies file existence, type and size.

Passport and ticket are mandatory. Visa remains configuration-driven.

## Payments

- `POST /orders/:id/payments` — body `{ "provider": "KHALTI" }`.
- Gateway-specific payloads remain private to their adapters.
- Only verified provider lookup results with matching order, amount and status confirm payment.
- Provider callbacks use `/api/v1/webhooks/payments/:provider` and are deduplicated by provider event ID.

## Connectivity

- `GET /orders/:id/connectivity` — selected provider, health and normalized capabilities.
- `GET /orders/:id/usage` — normalized usage after provisioning.
- Connectivity callbacks use `/api/v1/webhooks/connectivity/transatel` and are deduplicated.
- `TRANSATEL` is the production connectivity provider. It is executable only when the certified endpoint and OAuth credentials are configured.

## Notifications

- `POST /orders/:id/notifications` — body `{ "channel": "EMAIL", "template": "ORDER_STATUS" }`.
- Channels: `EMAIL`, `WHATSAPP`.
- Templates: `ORDER_STATUS`, `QR_READY`, `DOCUMENT_REUPLOAD`.
- The server derives the recipient from verified traveller data and queues delivery through BullMQ; partners cannot provide arbitrary recipients.

## Partner onboarding

Generate a random key, transmit it once through an approved secure channel, and configure only its SHA-256 hash:

```json
[{ "id": "agency-name", "keyHash": "64-character-sha256-hex" }]
```

Rotate keys by temporarily accepting both hashes, moving traffic to the new key, and then removing the old hash.
