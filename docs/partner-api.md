# Visa Compass Partner API

**Version:** v1  
**Base URL:** `https://<YOUR_API_HOST>/api/v1`  
**Interactive OpenAPI documentation:** `https://<YOUR_API_HOST>/api/partner-docs` (available only when `SWAGGER_ENABLED=true`)

This document describes the API exposed to commercial/reseller partners. It is based on the implemented v1 partner controllers and contracts.

## Integration at a glance

The recommended initial-purchase flow is:

1. Read capabilities and plans.
2. Create an extraction-first document-upload session with the passport and ticket.
3. Upload each document to its returned signed upload target, then confirm each upload.
4. Poll the document verification until `orderCreationAllowed` is `true`.
5. Create the order using the same `externalOrderId` and the returned `verificationId`.
6. Poll the order or receive configured outbound webhooks. Fetch eSIM details once the order is ready.

All monetary values are integer **NPR paisa**: `10000` means NPR 100.00.

## Authentication, headers, and envelopes

Every `/partners/*` endpoint requires a bearer API key:

```http
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Accept: application/json
```

Partner mutations (`POST`) require an idempotency key of 8–200 characters:

```http
Idempotency-Key: partner-request-20260831-0001
```

Reusing a key with the same method, endpoint, and request body safely returns the previously stored response. Reusing it with a different body returns `409 IDEMPOTENCY_CONFLICT`. Keys are retained for 24 hours.

You may supply `X-Correlation-Id` (1–128 letters, digits, `.`, `_`, or `-`). The service always returns `X-Correlation-Id`, plus `X-RateLimit-Limit` and `X-RateLimit-Remaining` for authenticated partner requests. A rate-limit response is `429 PARTNER_RATE_LIMITED` and includes `Retry-After`.

All JSON responses use the following envelope:

```json
{
  "data": {},
  "meta": {
    "correlationId": "f33c7dd1-74b8-49d0-a3a4-01b7b9ed085a",
    "timestamp": "2026-08-31T04:15:00.000Z"
  }
}
```

Errors use:

```json
{
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "traveler.email: Invalid email address",
    "details": [
      { "field": "traveler.email", "message": "Invalid email address" }
    ]
  },
  "meta": { "correlationId": "…", "timestamp": "…" }
}
```

Common status codes: `400` invalid input or unsupported state, `401` invalid/expired key, `403` missing scope or suspended partner, `404` unknown resource, `409` conflict/not-ready state, `410` expired/deprecated resource, `422` business-rule rejection, and `429` rate limited.

## API-key scopes

| Scope             | Access                                                        |
| ----------------- | ------------------------------------------------------------- |
| `catalog:read`    | Capabilities and plans                                        |
| `documents:write` | Document upload sessions and verification status/confirmation |
| `orders:read`     | Account, ledger, and orders/events                            |
| `orders:write`    | Create/cancel orders and request notifications                |
| `esims:read`      | eSIM activation details                                       |
| `refunds:write`   | Refund requests                                               |
| `usage:read`      | Active eSIM usage                                             |
| `checkout:write`  | Hosted checkout-link session creation                         |

## Recommended API endpoints

### Capabilities and plan catalogue

| Method | Path                         | Scope          | Description                                                              |
| ------ | ---------------------------- | -------------- | ------------------------------------------------------------------------ |
| `GET`  | `/partners/capabilities`     | `catalog:read` | API capabilities, currency, settlement methods, integration availability |
| `GET`  | `/partners/plans?country=JP` | `catalog:read` | Active sellable plans; optional ISO country filter                       |

`GET /partners/plans` returns an array of plans. Each item contains `id`, `countryCode`, `countryName`, `name`, `dataAllowance`, `validityDays`, `coverage`, `destination`, `price: { amountPaisa, currency }`, `requiredDocuments`, `availability`, `compatibilityDisclaimer`, `refundSummary`, `updatedAt`, and `currency`.

### 1. Create a document-upload session

New integrations must use the extraction-first sequence. Upload the passport
and ticket together, wait for extraction, then present the complete traveler
record for confirmation:

```json
{
  "mode": "EXTRACT_FIRST",
  "externalOrderId": "agency-order-1042",
  "documents": [
    {
      "type": "PASSPORT",
      "fileName": "passport.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 483120
    },
    {
      "type": "TICKET",
      "fileName": "ticket.jpg",
      "contentType": "image/jpeg",
      "sizeBytes": 342991
    }
  ]
}
```

The `mode` field is required and must be `EXTRACT_FIRST`. Traveler details are
collected from the passport extraction and confirmed separately; do not attach a
`traveler` object to this request.

`POST /partners/document-upload-sessions` — scope `documents:write`

Supply 2–3 unique documents, always including `PASSPORT` and `TICKET`. Accepted content types are `application/pdf`, `image/jpeg`, and `image/png`; each document must be no larger than 10 MiB. The response includes `verificationId`, expiry times, a status, and a signed `upload` object for each document. Upload the raw document using the method, URL, and headers in that signed object. Do not send document bytes to this API endpoint.

The session expires after 24 hours. Repeating a still-valid request for the same partner and `externalOrderId` resumes the session and returns fresh upload targets (`resumed: true`).

### 2. Confirm uploads and check verification

For an `EXTRACT_FIRST` session, the status response provides
`suggestedTraveler` and `travelerConfirmationRequired`. Suggested fields are
not authoritative: merge them without replacing user edits, collect every
remaining required field, and have the traveler confirm the result. When the
status is `AWAITING_TRAVELER_CONFIRMATION`, `MANUAL_ENTRY_REQUIRED`, or
`SKIPPED`, submit the complete traveler object to:

`POST /partners/document-verifications/{verificationId}/traveler` - scope `documents:write`

This idempotent mutation starts passport matching (or the configured manual or
no-review policy). `orderCreationAllowed` remains false until traveler
confirmation.

`POST /partners/document-verifications/{verificationId}/documents/{documentId}/confirm` — scope `documents:write`

No request body is required. Confirm every document after its signed upload finishes. The response reports `uploadVerified`, `remaining`, and whether verification was queued.

`GET /partners/document-verifications/{verificationId}` — scope `documents:write`

Poll this endpoint. Its response includes `status`, `failureCode`, `expiresAt`, `consumedAt`, `orderCreationAllowed`, and document-level status/code fields. Create an order only when `orderCreationAllowed` is `true`; allowable statuses are `VERIFIED`, `MANUAL_REVIEW`, `PROCESSING_BACKGROUND`, or `SKIPPED`. A verification can only be consumed by one order.

#### Corrections after a traveler-details mismatch

When the status is `MANUAL_REVIEW` with `failureCode`
`TRAVELLER_DETAILS_UNCONFIRMED`, the extracted traveler record did not match. The
partner may submit a corrected traveler object with a human-readable reason:

`POST /partners/document-verifications/{verificationId}/traveler-corrections` — scope `documents:write`

```json
{
  "traveler": {
    "title": "MR",
    "firstName": "Asha",
    "surname": "Shrestha",
    "dateOfBirth": "1990-05-14",
    "nationality": "NP",
    "city": "Kathmandu",
    "countryOfResidence": "NP",
    "email": "asha@example.com",
    "mobile": "+9779812345678",
    "passportNumber": "PA2233445",
    "passportExpiryDate": "2030-05-14"
  },
  "reason": "The passport number was transcribed incorrectly during extraction"
}
```

This is a mutation and therefore requires the `Idempotency-Key` header. `reason`
must be 10–500 characters. The field contract for `traveler` is the same as the
confirmation endpoint above.

Each accepted correction is recorded as an immutable revision. A verification
supports the initial confirmation plus at most three corrections — four
immutable versions in total. When the limit is reached, further attempts return
`409 TRAVELER_CORRECTION_LIMIT_REACHED` and the case must be reviewed manually.

The transaction is atomic: the first accepted correction changes the
verification from `MANUAL_REVIEW` to `PROCESSING`, so simultaneous different
corrections cannot both win. Re-sending a correction with the same
`Idempotency-Key` returns the previously stored revision unchanged (`replayed:
true`) instead of creating a new one. The re-queued verification runs passport
matching again against the corrected traveler data.

### 3. Create an order

`POST /partners/orders` — scope `orders:write`

For an initial purchase, submit:

```json
{
  "externalOrderId": "agency-order-1042",
  "externalCustomerId": "customer-91",
  "planId": "10000000-0000-4000-8000-000000000001",
  "settlement": { "method": "PARTNER_ACCOUNT" },
  "documentVerificationId": "20000000-0000-4000-8000-000000000001",
  "consent": {
    "compatibilityAccepted": true,
    "termsAccepted": true,
    "privacyAccepted": true,
    "acceptedAt": "2026-08-31T04:15:00.000Z"
  },
  "metadata": { "branch": "KTM-01" }
}
```

`externalOrderId`, `externalCustomerId`, and each metadata value are non-empty strings; their maximum lengths are 120, 120, and 500 respectively. `planId` and `documentVerificationId` are UUIDs. The consent acceptance fields must all be `true`, and `acceptedAt` must be an ISO 8601 datetime.

Only `PARTNER_ACCOUNT` settlement is supported. The amount is debited from the partner account when the order is accepted. The response is the complete partner order object; provisioning begins asynchronously.

For a top-up, set `purchaseType: "TOPUP"` and provide `topUpMobile`; do **not** send `documentVerificationId`. Despite the v1 field name, this value must be the provider-assigned MSISDN of the beneficiary eSIM, not the traveller's contact number. The eSIM may have been purchased through any Visa Compass channel. `externalCustomerId` identifies the partner-side purchaser; the top-up does not transfer ownership or grant usage, activation-detail, or lifecycle-management access. For a new purchase, `purchaseType` may be omitted (the default) and `documentVerificationId` is mandatory. A duplicate `externalOrderId` for the same partner returns `409 EXTERNAL_ORDER_ID_EXISTS`.

### Orders, eSIMs, usage, notifications, and refunds

| Method | Path                                                       | Scope           | Notes                                                                                                                                         |
| ------ | ---------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/partners/orders?cursor=&status=&externalOrderId=&limit=` | `orders:read`   | Lists partner-scoped orders. `limit` is 1–100, default 25. Returns `{ items, nextCursor }`.                                                   |
| `GET`  | `/partners/orders/{id}`                                    | `orders:read`   | Retrieves a partner-scoped order.                                                                                                             |
| `GET`  | `/partners/orders/by-external-id/{externalOrderId}`        | `orders:read`   | Retrieves by the partner's external order ID.                                                                                                 |
| `GET`  | `/partners/orders/{id}/events`                             | `orders:read`   | Partner event history, oldest first.                                                                                                          |
| `GET`  | `/partners/orders/{id}/esim`                               | `esims:read`    | Initial-purchase activation data after `QR_READY`, `ACTIVATION_ATTENTION`, or `COMPLETED`; blind top-up orders never grant activation access. |
| `GET`  | `/partners/orders/{id}/usage`                              | `usage:read`    | Usage only when the partner supplied the physical eSIM through an initial-purchase order.                                                     |
| `POST` | `/partners/orders/{id}/cancel`                             | `orders:write`  | Body: `{ "reason": "…" }`; reason length 3–1000. Allowed before provisioning.                                                                 |
| `POST` | `/partners/orders/{id}/refund-requests`                    | `refunds:write` | Body: `{ "reason": "…" }`; creates a refund request when eligible.                                                                            |
| `POST` | `/partners/orders/{id}/notifications`                      | `orders:write`  | Body: `{ "channel": "EMAIL", "template": "QR_READY" }`.                                                                                       |

Order-list status filters accept the service order-status enum, including `DRAFT`, `APPROVED`, `PROVISIONING`, `QR_READY`, `COMPLETED`, `CANCELLED`, `PROVISIONING_FAILED`, and `REFUND_PENDING`.

An order object includes `id`, `orderNumber`, `externalOrderId`, `status`, `settlementMethod`, `metadata`, `currency`, `totalAmountPaisa`, plan summary, `travelerComplete`, document summary, optional `refund`, status `timeline`, `fulfillmentStatus`, links, `esimDetailsAvailable`, `createdAt`, and `updatedAt`.

The eSIM response includes `iccid`, `msisdn`, `smDpAddress`, `activationCode`, `activatedAt`, and `expiresAt`. Treat `activationCode`, ICCID, and MSISDN as sensitive customer data.

Notification channels are `EMAIL` and `WHATSAPP`. Templates are `ORDER_STATUS`, `QR_READY`, and `DOCUMENT_REUPLOAD`; delivery uses the traveller contact recorded on the order.

### Partner account and ledger

| Method | Path                                                                                       | Scope         | Description                            |
| ------ | ------------------------------------------------------------------------------------------ | ------------- | -------------------------------------- |
| `GET`  | `/partners/account`                                                                        | `orders:read` | Account balance and order aggregates.  |
| `GET`  | `/partners/ledger?cursor=&from=&to=&externalOrderId=&orderNumber=&reference=&type=&limit=` | `orders:read` | Ledger entries with cursor pagination. |

Ledger `from` and `to` are ISO datetimes; `type` is `CREDIT`, `DEBIT`, `REFUND`, or `ADJUSTMENT`; `limit` is 1–100 (default 25). Entries contain `id`, `type`, `amountPaisa`, `balanceAfterPaisa`, `currency`, `reference`, optional order details, and `createdAt`.

## Hosted checkout links (no-code partners)

`POST /partners/hosted-checkout-sessions` — scope `checkout:write`

This endpoint is only available to partners approved for `CHECKOUT_LINK` integration. Its body is:

```json
{
  "planId": "10000000-0000-4000-8000-000000000001",
  "externalOrderId": "agency-order-1042",
  "externalCustomerId": "customer-91",
  "topUpMobile": "+33612345678",
  "allowInitialPurchaseFallback": true
}
```

`topUpMobile` and `allowInitialPurchaseFallback` are optional. Set the fallback flag only with explicit customer consent to create a new eSIM if the top-up cannot be performed. The response contains the time-limited checkout URL/token. The traveller then uses unauthenticated `/partner-checkout/{token}` endpoints to supply details, upload documents, complete verification, and pay. This hosted portal flow is customer-facing; it is not intended for server-to-server partner integrations.

## Outbound webhooks

Webhook endpoints are configured by Visa Compass administrators. When configured, Visa Compass POSTs events to the partner endpoint with this body:

```json
{
  "id": "event-uuid",
  "partnerId": "partner-uuid",
  "type": "order.accepted",
  "version": 0,
  "resourceId": "order-uuid",
  "occurredAt": "2026-08-31T04:15:00.000Z",
  "correlationId": "request-correlation-id",
  "data": {}
}
```

Headers:

```http
Content-Type: application/json
User-Agent: VisaCompass-Partner-Webhooks/1.0
VC-Event-Id: <event-id>
VC-Webhook-Timestamp: <unix-seconds>
VC-Webhook-Signature: v1=<hex-hmac>
```

Verify the HMAC-SHA256 signature over the exact raw request body:

```text
HMAC_SHA256(webhook_secret, "<timestamp>.<raw-body>")
```

Use `VC-Event-Id` for deduplication and reject stale timestamps according to your replay window. A 2xx response acknowledges delivery. The service does not follow redirects, times out after 10 seconds, and attempts delivery at most three times with exponential retry delay.

## Deprecated routes — do not integrate

The following remain for backward compatibility and should not be used in new integrations:

| Method | Path                                                   | Result                          |
| ------ | ------------------------------------------------------ | ------------------------------- |
| `POST` | `/partners/quotes`                                     | `410 QUOTES_DEPRECATED`         |
| `POST` | `/partners/orders/{id}/hosted-checkout-session`        | `410 HOSTED_PAYMENT_DEPRECATED` |
| `POST` | `/partners/orders/{id}/payment-session`                | `410 HOSTED_PAYMENT_DEPRECATED` |
| `POST` | `/partners/orders/{id}/traveler`                       | Deprecated legacy order flow    |
| `POST` | `/partners/orders/{id}/documents`                      | Deprecated legacy order flow    |
| `POST` | `/partners/orders/{id}/documents/{documentId}/confirm` | Deprecated legacy order flow    |

Use `POST /partners/document-upload-sessions` and then `POST /partners/orders` instead.
