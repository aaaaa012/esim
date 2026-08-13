# Visa Compass Partner API Specification

**API version:** v1  
**Audience:** approved Visa Compass commercial partners, resellers, and their engineering teams  
**Status:** implementation-aligned specification  
**Last verified against code:** 2026-08-13

> This document describes the externally consumable Partner API implemented by
> Visa Compass. It deliberately excludes internal customer, Operations, and
> Super Admin APIs. Replace `<api-base-url>` with the API URL supplied during
> partner onboarding. Do not use the example host as a production endpoint.

## 1. Service model

Visa Compass sells travel eSIM plans to partners on a prepaid-account basis.
There are two supported integration models:

1. **API integration (`API`)** — the partner collects traveller data and
   documents in its own application, then creates a complete order through
   the API.
2. **Hosted checkout (`CHECKOUT_LINK`)** — the partner creates a secure,
   single-use checkout link. The traveller completes the Visa Compass-hosted,
   partner-branded form. It is intended for partners that do not want to build
   traveller-document and checkout screens themselves.

Both models charge the partner's `PARTNER_ACCOUNT` balance in Nepalese paisa
(NPR × 100). Hosted payment through Visa Compass is **not available** to
partners: a partner collects its customer's payment directly and maintains a
prepaid Visa Compass balance.

Provisioning is asynchronous. A successful order submission means Visa
Compass accepted and funded the request; it does **not** mean the eSIM QR code
is ready. Poll the order or receive a configured webhook until its fulfilment
is ready.

## 2. URLs, content type, and response envelope

| Item | Value |
| --- | --- |
| API base | `<api-base-url>/api/v1` |
| Partner API prefix | `/partners` |
| Hosted checkout API prefix | `/partner-checkout` |
| Content type | `application/json` for API requests and responses |
| Character encoding | UTF-8 |
| Money | integer `amountPaisa` values; 100 paisa = NPR 1 |
| Time | ISO 8601 UTC timestamps, for example `2026-08-13T08:30:00.000Z` |
| IDs | UUID strings unless a field says otherwise |

All successful controller responses are wrapped:

```json
{
  "data": {},
  "meta": {
    "correlationId": "d7145d5c-5233-409c-bb38-4dc2c82d9707",
    "timestamp": "2026-08-13T08:30:00.000Z"
  }
}
```

All errors use this envelope:

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
  "meta": {
    "correlationId": "d7145d5c-5233-409c-bb38-4dc2c82d9707",
    "timestamp": "2026-08-13T08:30:00.000Z"
  }
}
```

`details` is present for schema-validation errors. Treat `error.code` as the
machine-readable decision field and `error.message` as safe display text.

## 3. Authentication, scopes, and request headers

### 3.1 Partner API authentication

Every `/partners` endpoint requires a credential provisioned by Visa Compass:

```http
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

The key prefix is 8–32 URL-safe characters after `vc_partner_`. Store the
secret in a server-side secrets manager; never expose it in browser code,
mobile applications, logs, URLs, or screenshots.

The credential must be active, unexpired, and belong to an `ACTIVE` or
`SUSPENDED` partner. Suspended partners may make `GET` requests but cannot
make mutations.

### 3.2 Scopes

Credentials receive only the scopes needed for their integration.

| Scope | Allows |
| --- | --- |
| `catalog:read` | capabilities and plan catalogue |
| `documents:write` | document-upload session creation |
| `orders:read` | order, order-list, event, account, and ledger reads |
| `orders:write` | complete orders, cancellations, and notification requests |
| `checkout:write` | hosted-checkout session creation |
| `esims:read` | QR/activation package retrieval |
| `refunds:write` | refund-request submission |
| `usage:read` | usage retrieval after activation |

An absent required scope returns HTTP `403` with
`PARTNER_SCOPE_FORBIDDEN`.

### 3.3 Standard headers

| Header | Required | Purpose |
| --- | --- | --- |
| `Authorization` | yes, `/partners` only | Partner bearer credential |
| `Content-Type: application/json` | for JSON POSTs | Request format |
| `x-correlation-id` | optional | Your trace ID. Visa Compass returns it, or creates a UUID when omitted. |
| `x-idempotency-key` | strongly required for every mutation | Deduplicates a repeated mutation. See below. |

The current implementation reads the header name **`x-idempotency-key`**.
The header is 8–200 characters. Reusing the same key on the same HTTP method
and path with the same body returns the earlier successful response. Reusing
it with a different body returns HTTP `409`. A concurrent duplicate can return
HTTP `409` with “Idempotent request is still being processed; retry shortly”.

Although controller metadata historically names `Idempotency-Key`, partners
must send `x-idempotency-key` until Visa Compass publishes a compatibility
alias. Generate a new UUID for each new business action and retain the key
through retries.

Every authenticated Partner API response also includes:

| Response header | Meaning |
| --- | --- |
| `x-correlation-id` | Request correlation ID; provide it to support. |
| `x-ratelimit-limit` | Partner's allowed requests per minute. |
| `x-ratelimit-remaining` | Remaining requests in the current minute window. |

Exceeding the partner-specific limit returns HTTP `429`, code
`PARTNER_RATE_LIMITED`.

## 4. Recommended API order flow

```text
1. GET  /partners/capabilities
2. GET  /partners/plans?country=JP
3. POST /partners/document-upload-sessions
4. Upload document bytes to the returned storage endpoint
5. POST /partners/orders
6. GET  /partners/orders/{id} until QR_READY or COMPLETED
7. GET  /partners/orders/{id}/esim when QR_READY or COMPLETED
8. GET  /partners/orders/{id}/usage after COMPLETED, as needed
```

The correct final delivery milestone is `QR_READY`: activation details can be
retrieved at `QR_READY` or `COMPLETED`. `COMPLETED` means the provider has
confirmed activation. Do not assume a QR package is available while an order
is `APPROVED` or `PROVISIONING`.

For link-based partners, replace steps 3–5 with `POST
/partners/hosted-checkout-sessions` and send the returned `checkoutUrl` to the
traveller. The traveller completes the public hosted-checkout endpoints.

## 5. Common data types and field rules

### 5.1 Traveller object

Used by complete API orders and hosted-checkout traveller updates.

| Field | Required | Rules | Description |
| --- | --- | --- | --- |
| `title` | yes | `MR`, `MS`, or `MRS` | Traveller title. |
| `firstName` | yes | trimmed, 1–80 chars | Given name. |
| `middleName` | no | trimmed, max 80 chars | Middle name. |
| `surname` | yes | trimmed, 1–80 chars | Family name. |
| `dateOfBirth` | yes | `YYYY-MM-DD`, must be in the past | Date of birth. |
| `nationality` | yes | exactly 2 chars | Country code. |
| `city` | yes | trimmed, 1–100 chars | City. |
| `countryOfResidence` | yes | exactly 2 chars | Country code. |
| `employerOrBusinessName` | no | trimmed, max 160 chars | Employer/business name. |
| `email` | yes | valid email | Delivery/contact email. |
| `mobile` | yes | 7–20 chars; digits, spaces, hyphens, optional leading `+` | Delivery/contact mobile. |
| `passportNumber` | yes | 5–30 chars; letters, numbers, hyphen | Passport number. |
| `passportExpiryDate` | yes | `YYYY-MM-DD`, future date | Passport expiry date. |
| `pointOfSaleCode` | no | trimmed, max 40 chars | Partner point-of-sale reference. |

Visa Compass encrypts sensitive traveller/passport data at rest. Do not put
passport data in `metadata`, URLs, or logs.

### 5.2 Documents

Document types are `PASSPORT`, `TICKET`, and `VISA`. The plan response tells
you which types are required. For an API complete order, submit 2–3 unique
document types. Upload-session requests support 1–3 unique documents.

Accepted declared content types are `application/pdf`, `image/jpeg`, and
`image/png`; declared size is 1–10,485,760 bytes (10 MiB). Visa Compass checks
the uploaded private asset against the declared type and byte size before
accepting an API order.

### 5.3 Pagination

Order and ledger lists accept a cursor from the preceding response:

```json
{ "data": { "items": [], "nextCursor": "..." } }
```

Pass that value as `cursor`. `nextCursor: null` means no further page. Default
page size is 25, maximum is 100.

### 5.4 Order status and fulfilment status

| Order status | Meaning for partners |
| --- | --- |
| `DRAFT` | Hosted checkout created but traveller has not completed it. |
| `APPROVED` | Funds accepted; handoff to provisioning is pending/starting. |
| `PROVISIONING` | Provider/inventory provisioning is in progress. |
| `QR_READY` | eSIM activation package is ready to retrieve and deliver. |
| `COMPLETED` | Provider confirmed activation. |
| `PROVISIONING_FAILED` | Provisioning failed and needs operational handling. |
| `CANCELLED` | Cancelled before provisioning; prepaid balance is refunded when applicable. |
| `REFUND_PENDING` | Partner refund request awaits Operations decision. |
| `REFUNDED` | Operations approved the refund and credited the prepaid account. |

The response field `fulfillmentStatus` is derived as follows: `PENDING` for
`APPROVED`/`PROVISIONING`; `READY` for `QR_READY`; `ACTIVATED` for
`COMPLETED`; `FAILED` for `PROVISIONING_FAILED`; otherwise `NOT_READY`.

## 6. Partner API endpoint reference

All paths below are relative to `<api-base-url>/api/v1`.

### 6.1 `GET /partners/capabilities`

**Scope:** `catalog:read`  
**Purpose:** discovers the current commercial/API capabilities for the
authenticated partner before integration behaviour is selected.

**Request:** no body.

**Success data:**

```json
{
  "apiVersion": "v1",
  "currency": "NPR",
  "settlementMethods": ["PARTNER_ACCOUNT"],
  "payments": [],
  "notifications": ["EMAIL", "WHATSAPP"],
  "connectivity": {
    "available": true
  },
  "idempotencyRequiredForMutations": true,
  "outboundWebhooks": true
}
```

`connectivity.available` reports only whether the eSIM fulfilment provider is
present and healthy. Provider identity and internal health detail are never
exposed to partners.

### 6.2 `GET /partners/plans`

**Scope:** `catalog:read`  
**Purpose:** lists active plans in active countries available to partners.

| Query field | Required | Rules | Description |
| --- | --- | --- | --- |
| `country` | no | country value is upper-cased by the API | Filter by destination ISO code. |

**Success data item:**

```json
{
  "id": "8d048c3f-1052-4d58-8837-09c02d86bb77",
  "countryCode": "JP",
  "countryName": "Japan",
  "name": "Japan 5 GB / 15 Days",
  "dataAllowance": "5 GB",
  "validityDays": 15,
  "coverage": ["Japan"],
  "destination": { "countryCode": "JP", "countryName": "Japan" },
  "price": { "amountPaisa": 249900, "currency": "NPR" },
  "requiredDocuments": ["PASSPORT", "TICKET"],
  "availability": "AVAILABLE",
  "compatibilityDisclaimer": "The traveler must confirm that the destination device supports eSIM before purchase.",
  "refundSummary": "Refund eligibility depends on payment, review, provisioning, and activation status.",
  "updatedAt": "2026-08-13T08:30:00.000Z",
  "currency": "NPR"
}
```

The current public catalogue amount is captured at order creation. Use
`price.amountPaisa`, not a cached local price, for commercial display.

### 6.3 `POST /partners/document-upload-sessions`

**Scope:** `documents:write`  
**Purpose:** creates short-lived private-upload intents to use in a subsequent
complete API order.  
**Recommended header:** `x-idempotency-key`.

```json
{
  "externalOrderId": "agency-order-1042",
  "documents": [
    {
      "type": "PASSPORT",
      "fileName": "passport.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 282143
    },
    {
      "type": "TICKET",
      "fileName": "ticket.jpg",
      "contentType": "image/jpeg",
      "sizeBytes": 113822
    }
  ]
}
```

| Request field | Required | Description |
| --- | --- | --- |
| `externalOrderId` | yes | Partner's unique order reference, 1–120 chars. It binds upload intents to the later order. |
| `documents` | yes | 1–3 documents with unique `type` values. |
| `documents[].type` | yes | `PASSPORT`, `TICKET`, or `VISA`. |
| `documents[].fileName` | yes | Original filename, 1–180 chars. |
| `documents[].contentType` | yes | `application/pdf`, `image/jpeg`, or `image/png`. |
| `documents[].sizeBytes` | yes | Exact client-declared file size, 1–10 MiB. |

**Success data:**

```json
{
  "externalOrderId": "agency-order-1042",
  "documents": [
    {
      "uploadId": "d5f1f947-1a93-45af-8a9d-776d0c29db6a",
      "type": "PASSPORT",
      "fileName": "passport.pdf",
      "expiresAt": "2026-08-13T08:45:00.000Z",
      "upload": {}
    }
  ]
}
```

`upload` contains the private-storage upload instructions returned by the
configured storage provider. Send the document bytes directly to that
provider using those instructions; do not send them to `/partners/orders`.
The intent expires 15 minutes after creation. Preserve each `uploadId`.

### 6.4 `POST /partners/orders` — complete order

**Scope:** `orders:write`  
**Purpose:** validates the plan, traveller, consent, and private uploads;
creates the order; atomically debits the partner account; and starts
asynchronous provisioning.  
**Header:** `x-idempotency-key` strongly required.

```json
{
  "externalOrderId": "agency-order-1042",
  "externalCustomerId": "customer-91",
  "planId": "8d048c3f-1052-4d58-8837-09c02d86bb77",
  "settlement": { "method": "PARTNER_ACCOUNT" },
  "traveler": {
    "title": "MR",
    "firstName": "Samir",
    "surname": "Majhi",
    "dateOfBirth": "1995-01-01",
    "nationality": "NP",
    "city": "Kathmandu",
    "countryOfResidence": "NP",
    "email": "samir@example.com",
    "mobile": "+9779800000000",
    "passportNumber": "PA1234567",
    "passportExpiryDate": "2030-01-01"
  },
  "documents": [
    { "type": "PASSPORT", "uploadId": "d5f1f947-1a93-45af-8a9d-776d0c29db6a" },
    { "type": "TICKET", "uploadId": "42f04c68-1666-4c1b-88dc-08f2be5a7e08" }
  ],
  "consent": {
    "compatibilityAccepted": true,
    "termsAccepted": true,
    "privacyAccepted": true,
    "acceptedAt": "2026-08-13T08:30:00.000Z"
  },
  "metadata": { "branch": "KTM-01", "agentReference": "A-228" }
}
```

| Field | Required | Rules and meaning |
| --- | --- | --- |
| `externalOrderId` | yes | Unique per partner; 1–120 chars. A duplicate returns `409`. |
| `externalCustomerId` | yes | Partner customer reference; 1–120 chars. Visa Compass maps it to a partner-scoped customer. |
| `planId` | yes | Active plan UUID from `GET /plans`. |
| `settlement` | no | Defaults to `{ "method": "PARTNER_ACCOUNT" }`. `HOSTED_PAYMENT` is accepted by request schema but rejected by business logic as deprecated. |
| `traveler` | yes | Full traveller object in section 5.1. |
| `documents` | yes | 2–3 distinct `{type, uploadId}` values. Must include all plan-required types and use unexpired intents created for this `externalOrderId`. |
| `consent.compatibilityAccepted` | yes | Must be `true`. |
| `consent.termsAccepted` | yes | Must be `true`. |
| `consent.privacyAccepted` | yes | Must be `true`. |
| `consent.acceptedAt` | yes | ISO 8601 date-time. |
| `metadata` | no | String-to-string map; each value max 500 chars. Do not place secrets or sensitive personal data here. |

The API verifies each uploaded asset before it creates the order. The asset's
actual size and file format must match the upload declaration.

**Success data:** the normalized order object in section 7. Its initial state
is normally `APPROVED` or `PROVISIONING`; poll `links.order` (or wait for a
webhook) until `fulfillmentStatus` is `READY` or `ACTIVATED`.

Key business errors include `PLAN_UNAVAILABLE`, `DOCUMENT_REQUIRED`,
`UPLOAD_NOT_VERIFIED`, `UPLOAD_EXPIRED`, `INSUFFICIENT_PARTNER_BALANCE`, and
`HOSTED_PAYMENT_DEPRECATED`.

### 6.5 `GET /partners/orders`

**Scope:** `orders:read`  
**Purpose:** lists only the authenticated partner's orders, newest first.

| Query field | Required | Rules |
| --- | --- | --- |
| `cursor` | no | Cursor returned by a previous page. |
| `status` | no | Any implemented order status enum. |
| `externalOrderId` | no | Exact partner external-order reference, max 120 chars. |
| `limit` | no | Integer 1–100; default 25. |

**Success data:** `{ "items": [<normalized order>], "nextCursor": "... or null" }`.

### 6.6 `GET /partners/orders/{id}` and `GET /partners/orders/by-external-id/{externalOrderId}`

**Scope:** `orders:read`  
**Purpose:** retrieves one normalized order. The order must belong to the
authenticated partner. `id` is the Visa Compass UUID; the alternative route
uses the partner's external order reference.

Both return the normalized order object in section 7. A missing/other
partner's order returns HTTP `404` with code `PARTNER_ORDER_NOT_FOUND`.

### 6.7 `GET /partners/orders/{id}/esim`

**Scope:** `esims:read`  
**Purpose:** returns the protected activation package only after the order is
`QR_READY` or `COMPLETED`.

**Success data:**

```json
{
  "orderId": "a7b2dd01-b5a8-4dd3-a4cb-497e362bc012",
  "externalOrderId": "agency-order-1042",
  "status": "QR_READY",
  "fulfillmentStatus": "READY",
  "iccid": "8988...",
  "msisdn": "+...",
  "smDpAddress": "...",
  "activationCode": "LPA:1$...",
  "activatedAt": null,
  "expiresAt": "2026-08-28T00:00:00.000Z"
}
```

| Field | Description |
| --- | --- |
| `iccid` | eSIM profile serial. |
| `msisdn` | Assigned mobile number, when available. |
| `smDpAddress` | SM-DP+ address, when available. |
| `activationCode` | Sensitive LPA activation payload. Show only to the entitled traveller over a protected channel. Never log it. |
| `activatedAt` | Provider-confirmed activation time, when available. |
| `expiresAt` | Subscription or inventory expiry time, when available. |

Before `QR_READY`, this returns HTTP `409` with code `PARTNER_ORDER_NOT_READY`.
Do not expect activation data in list, account, ledger, webhook, or standard
order responses.

### 6.8 `GET /partners/orders/{id}/events`

**Scope:** `orders:read`  
**Purpose:** returns partner event records for an order in ascending occurrence
order. Use it for reconciliation and support diagnostics.

**Success data item:**

```json
{
  "id": "b8da...",
  "type": "order.accepted",
  "version": "1.0",
  "resourceId": "a7b2dd01-b5a8-4dd3-a4cb-497e362bc012",
  "correlationId": "...",
  "payload": {},
  "occurredAt": "2026-08-13T08:30:00.000Z"
}
```

### 6.9 `GET /partners/orders/{id}/usage`

**Scope:** `usage:read`  
**Purpose:** requests provider usage for a provisioned eSIM.

The order must be `COMPLETED`; otherwise the API returns HTTP `400` with code
`PARTNER_USAGE_UNAVAILABLE` and “Usage details are available once the eSIM is
active”. The exact usage object is supplied by the active connectivity
provider. A typical response includes used and total megabytes:

```json
{ "usedMb": 512, "totalMb": 5120 }
```

Provider unavailability can return `USAGE_UNAVAILABLE` or a safe generic
server error.

### 6.10 `GET /partners/account`

**Scope:** `orders:read`  
**Purpose:** returns the partner's prepaid-account and aggregate commercial
metrics.

**Success data fields:**

| Field | Description |
| --- | --- |
| `currency` | Always `NPR`. |
| `balancePaisa`, `availableBalancePaisa` | Current account balance in paisa. |
| `totalDebitsPaisa`, `totalCreditsPaisa`, `totalRefundedPaisa`, `totalAdjustedPaisa` | Aggregate ledger totals. |
| `ordersCreated` | Number of partner orders. |
| `ordersByStatus` | Count keyed by order status. |
| `fulfilledOrders`, `failedOrders` | Derived aggregate counts. |
| `totalOrderValuePaisa`, `averageOrderValuePaisa` | Aggregate commercial value. |
| `updatedAt` | Partner account update time. |

### 6.11 `GET /partners/ledger`

**Scope:** `orders:read`  
**Purpose:** lists ledger entries for reconciliation.

| Query field | Required | Rules |
| --- | --- | --- |
| `cursor` | no | Page cursor. |
| `from`, `to` | no | ISO 8601 date-times; inclusive range. |
| `externalOrderId` | no | Exact external order ID. |
| `orderNumber` | no | Exact Visa Compass order number. |
| `reference` | no | Case-insensitive contains search. |
| `type` | no | `CREDIT`, `DEBIT`, `REFUND`, or `ADJUSTMENT`. |
| `limit` | no | Integer 1–100; default 25. |

**Success data item:**

```json
{
  "id": "...",
  "type": "DEBIT",
  "amountPaisa": 249900,
  "balanceAfterPaisa": 1250100,
  "currency": "NPR",
  "reference": "partner-order:agency-order-1042",
  "order": {
    "id": "...",
    "externalOrderId": "agency-order-1042",
    "orderNumber": "VC-2026-A7B2DD01"
  },
  "createdAt": "2026-08-13T08:30:00.000Z"
}
```

### 6.12 `POST /partners/orders/{id}/cancel`

**Scope:** `orders:write`  
**Purpose:** cancels an eligible order and, for direct prepaid orders, credits
the paid amount back to the partner account.

```json
{ "reason": "Traveller requested cancellation" }
```

`reason` is required, trimmed, 3–1,000 characters. Cancellation is allowed
only in `DRAFT`, `PAYMENT_PENDING`, `AWAITING_CUSTOMER`, `REVIEW_PENDING`, or
`APPROVED`. It is not available after provisioning starts. On success, the
normalized order has status `CANCELLED` and an `order.cancelled` event is
created for eligible webhook endpoints.

### 6.13 `POST /partners/orders/{id}/refund-requests`

**Scope:** `refunds:write`  
**Purpose:** creates an Operations review request; it does not itself issue a
credit.

```json
{ "reason": "Connectivity issue reported by traveller" }
```

The request is allowed only in `PAYMENT_CONFIRMED`, `REVIEW_PENDING`,
`APPROVED`, `PROVISIONING_FAILED`, or `COMPLETED`. Success creates a refund
record with status `REQUESTED`, moves the order to `REFUND_PENDING`, and
creates a `refund.requested` event. Operations may approve or reject it.
Approval credits the prepaid account, changes the order to `REFUNDED`, and
emits `order.refunded`.

### 6.14 `POST /partners/orders/{id}/notifications`

**Scope:** `orders:write`  
**Purpose:** asks Visa Compass to queue a message to the stored traveller
contact.

```json
{ "channel": "EMAIL", "template": "QR_READY" }
```

| Field | Allowed values | Meaning |
| --- | --- | --- |
| `channel` | `EMAIL`, `WHATSAPP` | Delivery channel. |
| `template` | `ORDER_STATUS`, `QR_READY`, `DOCUMENT_REUPLOAD` | Message template. |

The order must have a traveller. The response is the notification queue result;
delivery happens asynchronously and depends on the configured notification
service.

### 6.15 `POST /partners/hosted-checkout-sessions`

**Scope:** `checkout:write`  
**Purpose:** creates a 24-hour single-use, partner-branded hosted checkout
link. The partner itself must be configured with integration type
`CHECKOUT_LINK`; API-only partners receive `INTEGRATION_TYPE_FORBIDDEN`.

```json
{
  "planId": "8d048c3f-1052-4d58-8837-09c02d86bb77",
  "externalOrderId": "agency-order-1043",
  "externalCustomerId": "customer-92",
  "topUpMobile": "+9779800000000"
}
```

| Field | Required | Description |
| --- | --- | --- |
| `planId` | yes | Active plan UUID. |
| `externalOrderId` | yes | Unique 1–120 char partner reference. |
| `externalCustomerId` | yes | 1–120 char partner customer reference. |
| `topUpMobile` | no | Existing subscriber mobile, 1–20 chars. Used only to attempt top-up binding. |

**Success data:**

```json
{
  "sessionId": "...",
  "token": "sensitive-single-use-token",
  "checkoutUrl": "https://<customer-web-host>/partner-checkout/sensitive-single-use-token",
  "orderId": "...",
  "externalOrderId": "agency-order-1043",
  "expiresAt": "2026-08-14T08:30:00.000Z",
  "orderType": "TOPUP",
  "topUp": { "mobile": "+9779800000000", "status": "BOUND" }
}
```

Treat `token` and `checkoutUrl` as credentials: they allow access to the
checkout session. The server stores only a hash of the token. A valid top-up
requires an existing subscriber in the same plan country with persisted eSIM
inventory. If a mobile resolves but cannot be bound, the response reports
`topUp.status: "UNAVAILABLE"` and the resulting order is an
`INITIAL_PURCHASE`; do not advertise it as a top-up.

## 7. Normalized order response

`POST /partners/orders`, order reads, order listing, and cancellation return
this shape inside `data`:

```json
{
  "id": "a7b2dd01-b5a8-4dd3-a4cb-497e362bc012",
  "orderNumber": "VC-2026-A7B2DD01",
  "externalOrderId": "agency-order-1042",
  "status": "PROVISIONING",
  "settlementMethod": "PARTNER_ACCOUNT",
  "metadata": { "branch": "KTM-01" },
  "currency": "NPR",
  "totalAmountPaisa": 249900,
  "plan": {
    "id": "8d048c3f-1052-4d58-8837-09c02d86bb77",
    "countryCode": "JP",
    "name": "Japan 5 GB / 15 Days",
    "dataAllowance": "5 GB",
    "validityDays": 15
  },
  "travelerComplete": true,
  "documents": [{ "id": "...", "type": "PASSPORT", "status": "PENDING" }],
  "refund": null,
  "timeline": [{ "from": "APPROVED", "to": "PROVISIONING", "reason": null, "at": "..." }],
  "fulfillmentStatus": "PENDING",
  "links": {
    "order": "/api/v1/partners/orders/a7b2dd01-b5a8-4dd3-a4cb-497e362bc012",
    "events": "/api/v1/partners/orders/a7b2dd01-b5a8-4dd3-a4cb-497e362bc012/events",
    "esim": "/api/v1/partners/orders/a7b2dd01-b5a8-4dd3-a4cb-497e362bc012/esim"
  },
  "esimDetailsAvailable": false,
  "createdAt": "2026-08-13T08:30:00.000Z",
  "updatedAt": "2026-08-13T08:30:05.000Z"
}
```

`links` are relative paths. While an order is `APPROVED` or `PROVISIONING`,
poll `links.order` (or wait for a webhook) until `fulfillmentStatus` is
`READY` or `ACTIVATED`. Internal implementation fields (optimistic-concurrency
revision, pricing capture snapshots, payment-provider metadata) are never
returned to partners.

## 8. Public hosted-checkout API

These endpoints are called by Visa Compass's hosted checkout frontend. They
are public only in the sense that the opaque, single-use token grants access;
they do not use a Partner API bearer credential. Partners normally call only
the session-create endpoint in section 6.15, then share `checkoutUrl`.

All paths are relative to `<api-base-url>/api/v1/partner-checkout/{token}`.
The token must be 32–100 URL-safe characters, unexpired, and unconsumed.
Invalid, expired, or consumed tokens return `404 Hosted checkout not found`.

| Method and path suffix | Purpose | Body |
| --- | --- | --- |
| `GET /` | Read partner branding, plan, order status, document summary, and required document types. | none |
| `GET /documents` | Read document summary for a draft checkout. | none |
| `POST /traveler` | Upsert traveller details. | Traveller object from section 5.1. |
| `POST /documents` | Create a private upload instruction. | `{ "type": "PASSPORT", "fileName": "passport.pdf" }` |
| `POST /documents/{documentId}/confirm` | Verify that the private asset was uploaded. | none |
| `POST /verify-passport` | Runs passport OCR/field verification against saved traveller data. | none |
| `POST /complete` | Completes checkout, debits partner balance, consumes token, and starts provisioning. | `{ "consentAccepted": true }` |

For an `INITIAL_PURCHASE`, completion requires a traveller, every
destination-required document, uploaded/verified assets, and a passport
verification status of `VERIFIED` or local-simulator `SKIPPED`. For a bound
`TOPUP`, traveller/document/passport requirements are skipped. Completion is
allowed only while the order is `DRAFT`.

The public checkout response includes its partner name/slug/brand, plan,
amount, traveller completion flag, document statuses, and required document
types. It does not expose a partner account credential.

## 9. Outbound webhooks

Visa Compass Operations configures webhook URLs and event subscriptions for a
partner. A partner does not create webhook endpoints through the external
Partner API.

Each active eligible subscription receives an HTTP `POST` with:

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `user-agent` | `VisaCompass-Partner-Webhooks/1.0` |
| `vc-event-id` | Partner event UUID; use for deduplication. |
| `vc-webhook-timestamp` | Unix epoch seconds as a string. |
| `vc-webhook-signature` | `v1=<hex-hmac>` |

Body:

```json
{
  "id": "event-uuid",
  "partnerId": "partner-uuid",
  "type": "order.accepted",
  "version": "1.0",
  "resourceId": "order-uuid",
  "occurredAt": "2026-08-13T08:30:00.000Z",
  "correlationId": "correlation-uuid",
  "data": {}
}
```

### 9.1 Signature verification

The signing input is exactly:

```text
<vc-webhook-timestamp>.<raw-request-body>
```

Calculate HMAC-SHA256 using the webhook signing secret supplied only when
Operations creates/rotates the endpoint. Hex encode it and compare it to the
value after `v1=` using a constant-time comparison. Validate a reasonable
timestamp window and deduplicate `vc-event-id` before applying business
effects.

### 9.2 Delivery contract

Return any HTTP `2xx` promptly to acknowledge a delivery. Non-2xx responses,
connection failures, unsafe/unresolvable destinations, and timeouts are
retried. The delivery timeout is 10 seconds. The worker makes up to three
attempts with exponential retry scheduling; afterward the delivery status is
`FAILED` and Operations can replay it.

Implemented event types produced by partner order/refund workflows include:

| Event | When created |
| --- | --- |
| `order.accepted` | Complete API order accepted and funded. |
| `order.cancelled` | Eligible partner order cancelled. |
| `refund.requested` | Partner submitted a refund request. |
| `order.refunded` | Operations approved a refund. |

Subscribe with `*` to receive every emitted event, or subscribe to exact event
names. Event payloads are event-specific; use the order/events endpoint to
reconcile state and never infer QR credentials from a webhook.

## 10. Error and retry reference

| HTTP | Code / condition | Meaning and partner action |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid/missing field. Correct the request using `details`. |
| 400 | `PLAN_UNAVAILABLE` | Plan is no longer active/available; refresh catalogue. |
| 400 | `DOCUMENT_REQUIRED` | Required destination document type missing. |
| 400 | `UPLOAD_NOT_VERIFIED` | Upload intent is missing, belongs to another partner/order, consumed, or asset declaration did not match. Create a new upload session and upload again. |
| 400 | `UPLOAD_EXPIRED` | Upload intent exceeded 15 minutes. Create a new session. |
| 400 | `PASSPORT_REQUIRED` / `PASSPORT_VERIFICATION_REQUIRED` | Hosted checkout needs passport upload/verification before initial-purchase completion. |
| 400 | `INTEGRATION_TYPE_FORBIDDEN` | Partner is not approved for checkout links; contact Visa Compass Operations. |
| 400 | `HOSTED_PAYMENT_DEPRECATED` | Do not use hosted payment; use prepaid `PARTNER_ACCOUNT`. |
| 401 | `PARTNER_UNAUTHORIZED` | Missing, malformed, expired, revoked, or invalid partner key. Rotate/check credential. |
| 403 | `PARTNER_SCOPE_FORBIDDEN` | Credential lacks endpoint scope. |
| 403 | `PARTNER_SUSPENDED` | Partner is suspended; mutations are blocked. |
| 404 | `PARTNER_ORDER_NOT_FOUND` / `PARTNER_DOCUMENT_NOT_FOUND` / `PARTNER_NOT_FOUND` | Order/document/partner not found or not owned by this partner. Hosted tokens also intentionally return `HOSTED_CHECKOUT_NOT_FOUND`. |
| 409 | `EXTERNAL_ORDER_ID_EXISTS` / `UPLOAD_ALREADY_CONSUMED` / `PARTNER_ORDER_NOT_READY` / `ORDER_CONFLICT` / `PARTNER_BALANCE_CONFLICT` / `IDEMPOTENCY_CONFLICT` | Duplicate external order ID, reused upload, activation requested too early, concurrent change, or idempotency replay mismatch. Fetch current order and decide whether to retry. |
| 429 | `PARTNER_RATE_LIMITED` | Per-minute partner limit exceeded. Back off until the next window; inspect rate-limit headers. |
| 5xx | `UNEXPECTED` | Internal failure; retry only safe/idempotent work with the same `x-idempotency-key`, and provide correlation ID to support. |

Other implemented stable business codes may be returned by shared services,
including `INSUFFICIENT_PARTNER_BALANCE`, `INVENTORY_UNAVAILABLE`,
`PROVISIONING_FAILED`, `USAGE_UNAVAILABLE`, and connectivity/payment error
codes. Do not retry insufficient-balance errors until the account is credited.

## 11. Deprecated routes — do not integrate

The following routes are retained only for backward compatibility and return
`Deprecation: true` headers. New integrations must not use them.

| Route | Current behavior | Replacement |
| --- | --- | --- |
| `POST /partners/quotes` | HTTP 410 `QUOTES_DEPRECATED` | `POST /partners/orders` complete order. |
| Quote-shaped `POST /partners/orders` | HTTP 410 `LEGACY_PARTNER_ORDER_DEPRECATED` | Complete order with `planId`, traveller, documents, consent. |
| `POST /partners/orders/{id}/traveler` | Deprecated legacy flow | Include traveller in complete order. |
| `POST /partners/orders/{id}/documents` | Deprecated legacy flow | `POST /partners/document-upload-sessions`. |
| `POST /partners/orders/{id}/documents/{documentId}/confirm` | Deprecated legacy flow | Use document-upload sessions plus complete order. |
| `POST /partners/orders/{id}/hosted-checkout-session` | HTTP 410 `HOSTED_PAYMENT_DEPRECATED` | `POST /partners/hosted-checkout-sessions`. |
| `POST /partners/orders/{id}/payment-session` | HTTP 410 `HOSTED_PAYMENT_DEPRECATED` | Prepaid partner account; no Visa Compass hosted payment. |

## 12. Integration checklist

Before production enablement, a partner should prove:

1. It keeps credentials and webhook signing secrets server-side.
2. It sends `x-idempotency-key` for every mutation and reuses it for retries.
3. It persists Visa Compass `id`, `externalOrderId`, and correlation IDs.
4. It uploads only via the returned private upload instructions and does not
   log upload tokens or document locations.
5. It does not deliver QR data until `QR_READY` or `COMPLETED` and retrieves
   it only through the protected eSIM endpoint.
6. It implements polling plus webhook receipt/deduplication; neither is the
   sole source of truth.
7. It handles `PROVISIONING_FAILED`, cancellation limits, refund review, and
   insufficient partner balance in customer/operations workflows.
8. It tests against the Visa Compass UAT endpoint and receives approval before
   production credentials are issued.

## 13. Support information to include in every ticket

Provide the partner code, `externalOrderId`, Visa Compass order UUID/order
number (if available), request time in UTC, HTTP status, error code, and
`x-correlation-id`. Never send API secrets, activation codes, full passport
numbers, or raw identity documents to support channels.

## 14. Complete HTTP operation matrix

This is the complete external operation list. Every URL is relative to
`<api-base-url>/api/v1`; successful responses wrap the listed result in the
section 2 envelope.

| # | Method | URL | Authentication / scope | Idempotency | Success `data` | Main non-2xx cases |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | GET | `/partners/capabilities` | Bearer; `catalog:read` | no | `Capabilities` | 401, 403, 429 |
| 2 | GET | `/partners/plans` | Bearer; `catalog:read` | no | `Plan[]` | 400, 401, 403, 429 |
| 3 | POST | `/partners/document-upload-sessions` | Bearer; `documents:write` | recommended | `UploadSessionBatch` | 400, 401, 403, 429, 503 |
| 4 | POST | `/partners/orders` | Bearer; `orders:write` | strongly required | `PartnerOrder` | 400, 401, 403, 409, 410, 429, 5xx |
| 5 | GET | `/partners/orders` | Bearer; `orders:read` | no | `Page<PartnerOrder>` | 400, 401, 403, 429 |
| 6 | GET | `/partners/orders/{id}` | Bearer; `orders:read` | no | `PartnerOrder` | 401, 403, 404, 429 |
| 7 | GET | `/partners/orders/by-external-id/{externalOrderId}` | Bearer; `orders:read` | no | `PartnerOrder` | 401, 403, 404, 429 |
| 8 | GET | `/partners/orders/{id}/esim` | Bearer; `esims:read` | no | `ActivationPackage` | 401, 403, 404, 409, 429 |
| 9 | GET | `/partners/orders/{id}/events` | Bearer; `orders:read` | no | `PartnerEvent[]` | 401, 403, 404, 429 |
| 10 | GET | `/partners/orders/{id}/usage` | Bearer; `usage:read` | no | provider usage object | 400, 401, 403, 404, 429, provider error |
| 11 | GET | `/partners/account` | Bearer; `orders:read` | no | `PartnerAccountSummary` | 401, 403, 429 |
| 12 | GET | `/partners/ledger` | Bearer; `orders:read` | no | `Page<LedgerEntry>` | 400, 401, 403, 429 |
| 13 | POST | `/partners/orders/{id}/cancel` | Bearer; `orders:write` | strongly required | `PartnerOrder` | 400, 401, 403, 404, 409, 429 |
| 14 | POST | `/partners/orders/{id}/refund-requests` | Bearer; `refunds:write` | strongly required | `RefundRequest` | 400, 401, 403, 404, 409, 429 |
| 15 | POST | `/partners/orders/{id}/notifications` | Bearer; `orders:write` | strongly required | notification queue result | 400, 401, 403, 404, 429 |
| 16 | POST | `/partners/hosted-checkout-sessions` | Bearer; `checkout:write` | strongly required | `HostedCheckoutSession` | 400, 401, 403, 409, 429 |
| 17 | GET | `/partner-checkout/{token}` | opaque URL token | no | `HostedCheckoutView` | 404 |
| 18 | GET | `/partner-checkout/{token}/documents` | opaque URL token | no | `{documents: HostedDocument[]}` | 400, 404 |
| 19 | POST | `/partner-checkout/{token}/traveler` | opaque URL token | no | `HostedCheckoutView` | 400, 404, 409 |
| 20 | POST | `/partner-checkout/{token}/documents` | opaque URL token | no | `HostedDocumentUpload` | 400, 404, 409, 503 |
| 21 | POST | `/partner-checkout/{token}/documents/{documentId}/confirm` | opaque URL token | no | `DocumentConfirmation` | 400, 404, 503 |
| 22 | POST | `/partner-checkout/{token}/verify-passport` | opaque URL token | no | passport-verification result | 400, 404, 5xx |
| 23 | POST | `/partner-checkout/{token}/complete` | opaque URL token | no | `HostedCheckoutCompletion` | 400, 404, 409 |

The public hosted routes are meant for the Visa Compass checkout page. Partners
normally call only row 16 and send `checkoutUrl` to their traveller. The token
is a credential: it is single-use, valid for 24 hours, and intentionally
returns 404 when invalid, expired, or consumed.

## 15. Exact response object definitions

The following defines **every response field that is stable in current code**.
All objects are contained in `data` unless stated otherwise.

### `Capabilities`

| Field | JSON type | Values / meaning |
| --- | --- | --- |
| `apiVersion` | string | Current value `v1`. |
| `currency` | string | `NPR`. |
| `settlementMethods` | string array | Current value `["PARTNER_ACCOUNT"]`. |
| `payments` | array | Current value `[]`; hosted Visa Compass payment is unavailable. |
| `notifications` | string array | `EMAIL`, `WHATSAPP`. |
| `connectivity` | object | `{available:boolean}`. Reports whether eSIM fulfilment is reachable; provider identity and health internals are not exposed. |
| `idempotencyRequiredForMutations` | boolean | Current value `true`. |
| `outboundWebhooks` | boolean | Current value `true`. |

### `Plan`

| Field | JSON type | Description |
| --- | --- | --- |
| `id` | UUID string | Use as `planId`. |
| `countryCode`, `countryName` | string | Plan destination. |
| `name`, `dataAllowance` | string | Display values. |
| `validityDays` | integer | Validity in days. |
| `coverage` | string array | Catalogue/provider coverage locations. |
| `destination` | object | `{countryCode:string,countryName:string}`. |
| `price` | object | `{amountPaisa:integer,currency:"NPR"}`. |
| `requiredDocuments` | string array | Subset of `PASSPORT`, `TICKET`, `VISA`. |
| `availability` | string | Current value `AVAILABLE`. |
| `compatibilityDisclaimer`, `refundSummary` | string | Safe partner-display statements. |
| `updatedAt` | ISO date-time string | Catalogue update time. |
| `currency` | string | `NPR`. |

### `UploadSessionBatch`

| Field | JSON type | Description |
| --- | --- | --- |
| `externalOrderId` | string | Input partner reference. |
| `documents` | array | One result per requested document. |
| `documents[].uploadId` | UUID string | Required later in complete order `documents[].uploadId`. |
| `documents[].type` | `DocumentType` | Requested type. |
| `documents[].fileName` | string | Declared original name. |
| `documents[].expiresAt` | ISO date-time | Upload intent expiration (15 minutes). |
| `documents[].upload.mode` | string | `cloudinary-signed` or non-production `local-simulator`. |
| `documents[].upload.endpoint` | URL string, optional | Storage upload endpoint. |
| `documents[].upload.cloudName`, `apiKey`, `publicId` | string, optional | Cloudinary upload inputs. |
| `documents[].upload.deliveryType` | string, optional | `authenticated` when Cloudinary signed. |
| `documents[].upload.timestamp` | integer | Unix seconds for signature. |
| `documents[].upload.signature` | string | Provider upload signature. |
| `documents[].upload.folder` | string | Private storage folder. |
| `documents[].upload.expiresInSeconds` | integer | Instruction TTL, currently 900. |

Upload to the returned endpoint with the returned fields unchanged. In signed
Cloudinary mode include `type=authenticated`; do not alter public ID, folder,
or transformation. The API verifies private asset byte count and format before
accepting an API order.

### `PartnerOrder`

| Field | JSON type | Description / possible values |
| --- | --- | --- |
| `id` | UUID string | Visa Compass order ID. |
| `orderNumber` | string | Human-readable Visa Compass reference. |
| `externalOrderId` | string or null | Partner reference. |
| `status` | `OrderStatus` | Full enum in section 16. |
| `settlementMethod` | string or null | Supported working value `PARTNER_ACCOUNT`. |
| `metadata` | object or null | Partner-supplied request data echoed back; do not treat undisclosed keys as fixed schema. |
| `currency` | string | `NPR`. |
| `totalAmountPaisa` | integer | Captured charged price in paisa. |
| `plan` | object | `{id,countryCode,name,dataAllowance,validityDays}`. |
| `travelerComplete` | boolean | Whether traveller record exists. |
| `documents` | array | Each `{id:UUID,type:DocumentType,status:DocumentStatus}`. |
| `refund` | object/null | Latest partner refund request if any. |
| `timeline` | array | `{from:OrderStatus|null,to:OrderStatus,reason:string|null,at:ISO date-time}`. |
| `fulfillmentStatus` | string | `PENDING`, `READY`, `ACTIVATED`, `FAILED`, `NOT_READY`. |
| `links` | object | Relative `order`, `events`, and `esim` paths. |
| `esimDetailsAvailable` | boolean | True only for `QR_READY`/`COMPLETED`. |
| `createdAt`, `updatedAt` | ISO date-time | Audit timestamps. |

### Other response objects

| Object | Exact fields |
| --- | --- |
| `ActivationPackage` | `orderId`, `externalOrderId`, `status`, `fulfillmentStatus`, `iccid`, `msisdn`, `smDpAddress`, `activationCode`, `activatedAt`, `expiresAt`. Values except identifiers/status may be null when provider has not supplied them. `activationCode` is sensitive. |
| `PartnerEvent` | `id`, `type`, `version`, `resourceId`, `correlationId`, `payload`, `occurredAt`. |
| `Page<PartnerOrder>` | `{items: PartnerOrder[], nextCursor: string|null}`. |
| `LedgerEntry` | `id`, `type`, `amountPaisa`, `balanceAfterPaisa`, `currency`, `reference`, `order`, `createdAt`; `order` is `{id,externalOrderId,orderNumber}` or null. |
| `PartnerAccountSummary` | `currency`, `balancePaisa`, `availableBalancePaisa`, `totalDebitsPaisa`, `totalCreditsPaisa`, `totalRefundedPaisa`, `totalAdjustedPaisa`, `ordersCreated`, `ordersByStatus`, `fulfilledOrders`, `failedOrders`, `totalOrderValuePaisa`, `averageOrderValuePaisa`, `updatedAt`. |
| `RefundRequest` | `id`, `partnerId`, `orderId`, `amountPaisa`, `reason`, `status`, `decidedById`, `decidedAt`, `createdAt`, `updatedAt`. |
| `HostedCheckoutSession` | `sessionId`, `token`, `checkoutUrl`, `orderId`, `externalOrderId`, `expiresAt`, `orderType`, optional `topUp`. `orderType` is `TOPUP` or `INITIAL_PURCHASE`; optional `topUp.status` is `BOUND` or `UNAVAILABLE`. |
| `HostedCheckoutView` | `sessionId`, `expiresAt`, `partner:{name,slug,brand}`, `order:{id,orderNumber,orderType,status,amountPaisa,amountNpr,currency,plan,travelerComplete,documents,requiredDocuments}`. |
| `HostedDocumentUpload` | `id`, `type`, `status`, `upload` (same instruction shape as upload session). |
| `DocumentConfirmation` | `id`, `type`, `status`, `uploadVerified:true`. |
| `HostedCheckoutCompletion` | `orderId`, `orderNumber`, `status`. |

## 16. Complete enum, parameter, and validation reference

### 16.1 Enumerations

| Enum | Every possible value |
| --- | --- |
| `OrderStatus` | `DRAFT`, `PAYMENT_PENDING`, `PAYMENT_CONFIRMED`, `REVIEW_PENDING`, `AWAITING_CUSTOMER`, `APPROVED`, `PROVISIONING`, `QR_READY`, `COMPLETED`, `PAYMENT_FAILED`, `CANCELLED`, `PROVISIONING_FAILED`, `REFUND_PENDING`, `REFUNDED` |
| `DocumentType` | `PASSPORT`, `TICKET`, `VISA` |
| `DocumentStatus` | `PENDING`, `APPROVED`, `REJECTED`, `REUPLOAD_REQUIRED` |
| Traveller `title` | `MR`, `MS`, `MRS` |
| Settlement request `method` | `PARTNER_ACCOUNT`, `HOSTED_PAYMENT` (the latter is rejected as deprecated) |
| Partner integration type | `API`, `CHECKOUT_LINK` (Operations-configured) |
| Notification `channel` | `EMAIL`, `WHATSAPP` |
| Notification `template` | `ORDER_STATUS`, `QR_READY`, `DOCUMENT_REUPLOAD` |
| Ledger query `type` | `CREDIT`, `DEBIT`, `REFUND`, `ADJUSTMENT` |
| Refund `status` | `REQUESTED`, `APPROVED`, `REJECTED`, `PROCESSING`, `COMPLETED`, `FAILED` |
| Webhook delivery status | `PENDING`, `DELIVERED`, `RETRYING`, `FAILED` |

### 16.2 Request fields, types, and limits

| Endpoint / field | Required | JSON type | Exact accepted constraint |
| --- | ---: | --- | --- |
| `GET /plans.country` | no | string | API upper-cases it; use destination ISO code. |
| Complete / hosted `externalOrderId` | yes | string | Trimmed, min 1, max 120; unique per partner. |
| Complete / hosted `externalCustomerId` | yes | string | Trimmed, min 1, max 120. |
| Complete / hosted `planId` | yes | string | UUID of active catalogue plan. |
| Complete `settlement` | no | object | Defaults to `{method:"PARTNER_ACCOUNT"}`. |
| `settlement.method` | if settlement | string enum | Values listed above; only `PARTNER_ACCOUNT` is operational. |
| `documents` for complete order | yes | array | 2–3 items; all `type` values unique. |
| Upload-session `documents` | yes | array | 1–3 items; all `type` values unique. |
| `documents[].type` | yes | string enum | `PASSPORT`, `TICKET`, `VISA`. |
| `documents[].uploadId` | complete only | string | UUID from an unexpired, unconsumed upload session for same partner/external order. |
| `documents[].fileName` | upload session/hosted | string | Trimmed, min 1, max 180. |
| `documents[].contentType` | upload session | string enum | `application/pdf`, `image/jpeg`, `image/png`. |
| `documents[].sizeBytes` | upload session | integer | Min 1, max 10,485,760; must equal actual uploaded bytes in production storage. |
| `traveler` | complete and hosted traveller post | object | All required fields below. |
| `traveler.title` | yes | string enum | `MR`, `MS`, `MRS`. |
| `traveler.firstName`, `surname` | yes | string | Trimmed, min 1, max 80 each. |
| `traveler.middleName` | no | string | Trimmed, max 80. |
| `traveler.dateOfBirth` | yes | string | `YYYY-MM-DD`, strictly in the past. |
| `traveler.nationality`, `countryOfResidence` | yes | string | Exactly 2 characters. |
| `traveler.city` | yes | string | Trimmed, min 1, max 100. |
| `traveler.employerOrBusinessName` | no | string | Trimmed, max 160. |
| `traveler.email` | yes | string | Valid email. |
| `traveler.mobile` | yes | string | Trimmed, 7–20 chars; `+` optional, then digits/spaces/hyphens only. |
| `traveler.passportNumber` | yes | string | Trimmed, 5–30; letters, digits, hyphen only. |
| `traveler.passportExpiryDate` | yes | string | `YYYY-MM-DD`, strictly future date. |
| `traveler.pointOfSaleCode` | no | string | Trimmed, max 40. |
| `consent.compatibilityAccepted`, `termsAccepted`, `privacyAccepted` | yes | boolean | Each must literally be `true`. |
| `consent.acceptedAt` | yes | string | ISO 8601 date-time. |
| `metadata` values | no | object string map | Every value is string max 500. Never put PII/secrets here. |
| Hosted `topUpMobile` | no | string | Trimmed, min 1, max 20. |
| Cancel/refund `reason` | yes | string | Trimmed, min 3, max 1,000. |
| Notification body | yes | object | Exact `channel` and `template` enums above. |
| Hosted complete `consentAccepted` | yes | boolean | Must literally be `true`. |
| List/ledger `limit` | no | integer or integer string | 1–100, default 25. |
| List/ledger `cursor` | no | string | UUID-form opaque cursor returned by preceding page. |
| Ledger `from`, `to` | no | string | ISO 8601 date-time. |
| `x-idempotency-key` | mutations | string | Current implementation accepts 8–200 characters. |

### 16.3 State-specific operation rules

| Operation | Allowed order statuses | Result if status is not allowed |
| --- | --- | --- |
| Retrieve activation package | `QR_READY`, `COMPLETED` | 409: `PARTNER_ORDER_NOT_READY` — `Activation details are available once the eSIM is ready to use`. |
| Retrieve usage | `COMPLETED` only | 400: `PARTNER_USAGE_UNAVAILABLE` — `Usage details are available once the eSIM is active`. |
| Cancel | `DRAFT`, `PAYMENT_PENDING`, `AWAITING_CUSTOMER`, `REVIEW_PENDING`, `APPROVED` | 400: `PARTNER_ORDER_INVALID_STATE` — `Order cannot be changed in its current state`. |
| Request refund | `PAYMENT_CONFIRMED`, `REVIEW_PENDING`, `APPROVED`, `PROVISIONING_FAILED`, `COMPLETED` | 400: `PARTNER_ORDER_INVALID_STATE` — `Order cannot be changed in its current state`. |
| Hosted set traveller | `DRAFT` | 400: `PARTNER_ORDER_INVALID_STATE` — `Order cannot be changed in its current state`. |
| Hosted add document | `DRAFT`, `AWAITING_CUSTOMER` | 400: `PARTNER_ORDER_INVALID_STATE` — `Order cannot be changed in its current state`. |
| Hosted complete | `DRAFT` only | 400: `HOSTED_CHECKOUT_COMPLETED` — `Hosted checkout is already completed`. |

## 17. Complete partner-visible error/code/message contract

The exact response body always uses the error envelope in section 2. Business
rules and the partner service return stable, self-describing codes; only basic
framework exceptions (e.g. unsupported method, unhandled storage/validation of
non-business fields) fall back to `HTTP_<n>`. The table lists the current
contract.

| HTTP | `error.code` | Exact current `error.message` | When it occurs | Required client behavior |
| ---: | --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `<field>: <Zod validation message>` | Any field/range/enum/date validation failure. | Read `details`, correct request, create a new idempotency key only if this is a new corrected business request. |
| 400 | `PLAN_UNAVAILABLE` | `Plan is unavailable` | Plan absent, inactive, or destination disabled. | Refresh catalogue. |
| 400 | `DOCUMENT_REQUIRED` | `Required documents missing: <comma-separated types>` | Direct order lacks plan-required type. | Upload every missing type. |
| 400 | `DOCUMENT_REQUIRED` | `Required document missing: <type>` | Hosted initial purchase lacks required stored document. | Upload/confirm named type. |
| 400 | `UPLOAD_NOT_VERIFIED` | `One or more document uploads are unavailable` | Intent missing/wrong partner/order/consumed. | Create new sessions and upload again. |
| 400 | `UPLOAD_NOT_VERIFIED` | `Document upload type does not match` | Submitted document type differs from intent. | Correct mapping. |
| 400 | `UPLOAD_NOT_VERIFIED` | `Uploaded document does not match its declaration` | Actual storage size/format mismatches declaration. | Recreate correct upload intent and upload again. |
| 400 | `UPLOAD_EXPIRED` | `One or more document uploads have expired` | 15-minute intent expired. | Create new upload session. |
| 400 | `INSUFFICIENT_PARTNER_BALANCE` | `Partner prepaid balance is insufficient` | Balance lower than charged plan price. | Credit account; do not blind retry. |
| 400 | `INTEGRATION_TYPE_FORBIDDEN` | `This partner is not approved for hosted checkout links` | API partner calls hosted-session operation. | Ask Operations to configure `CHECKOUT_LINK`. |
| 400 | `PASSPORT_REQUIRED` | `Upload a passport before verification` | Hosted verify called without passport. | Upload passport. |
| 400 | `TRAVELER_REQUIRED` | `Traveller details are required before verification` | Hosted verify called before traveller exists. | Save traveller first. |
| 400 | `PASSPORT_VERIFICATION_REQUIRED` | `Passport verification is required before completion` | Hosted initial purchase has no `VERIFIED`/`SKIPPED` passport verdict. | Verify/re-upload/correct traveller data. |
| 400 | `HOSTED_CHECKOUT_COMPLETED` | `Hosted checkout is already completed` | Complete called after draft state. | Treat token as no longer usable; retrieve order. |
| 400 | `PARTNER_TRAVELER_REQUIRED` | `Traveller details are required` | Hosted initial purchase completed without traveller. | Submit traveller. |
| 400 | `PARTNER_ORDER_INVALID_STATE` | `Order cannot be changed in its current state` | Mutation violates table in 16.3. | Fetch order; do not retry unless state changes legitimately. |
| 400 | `PARTNER_USAGE_UNAVAILABLE` | `Usage details are available once the eSIM is active` | Usage read before completed. | Poll/webhook until completed. |
| 400 | `PARTNER_TRAVELER_REQUIRED` | `Traveller contact details are required` | Notification request without traveller. | Ensure traveller exists. |
| 400 | `PARTNER_DOCUMENT_INVALID` | `Document must be a PDF, JPG or PNG up to 10 MB` | Stored document invalid. | Upload a valid file. |
| 400 | `PARTNER_DOCUMENT_INVALID` | `Document upload could not be verified` | Storage verification failed. | Retry after upload completion or create a new upload session. |
| 400 | `INVALID_IDEMPOTENCY_KEY` | `Invalid idempotency key` | Key length outside 8–200. | Generate valid key. |
| 401 | `PARTNER_UNAUTHORIZED` | `Your API key is invalid.` / `Your API key is invalid or has expired.` | Missing, malformed, revoked, expired, or incorrect bearer key. | Correct header/credential. |
| 401 | `PARTNER_UNAUTHORIZED` | `Authentication is temporarily unavailable. Please try again shortly.` | Partner persistence unavailable. | Retry later; contact support. |
| 403 | `PARTNER_SCOPE_FORBIDDEN` | `Your API key is not allowed to use this endpoint. Contact support to request access.` | Credential lacks endpoint scope. | Ask Operations for credential scope. |
| 403 | `PARTNER_SUSPENDED` | `Your partner account is suspended. Contact support for help.` | Suspended partner makes non-GET call. | Contact Operations. |
| 404 | `PARTNER_ORDER_NOT_FOUND` | `Order not found` | Order missing or belongs to another partner. | Verify order/credential. |
| 404 | `PARTNER_ACTIVATION_UNAVAILABLE` | `Activation details are not available yet` | Eligible order has no eSIM record. | Contact Operations with correlation ID. |
| 404 | `PARTNER_DOCUMENT_NOT_FOUND` | `Document not found` | Hosted/legacy document missing/not owned. | Reload state. |
| 404 | `HOSTED_CHECKOUT_NOT_FOUND` | `Hosted checkout not found` | Token malformed, expired, consumed, invalid, or session order missing. | Create new hosted session. |
| 404 | `PARTNER_NOT_FOUND` | `Partner not found` | Authenticated partner record missing or inactive. | Contact Operations. |
| 409 | `EXTERNAL_ORDER_ID_EXISTS` | `External order ID already exists` | Partner reused external order reference. | GET by external ID. |
| 409 | `UPLOAD_ALREADY_CONSUMED` | `Document upload was already consumed` | Upload session reused/raced. | Never reuse upload IDs. |
| 409 | `PARTNER_ORDER_NOT_READY` | `Activation details are available once the eSIM is ready to use` | eSIM endpoint too early. | Poll status. |
| 409 | `ORDER_CONFLICT` | `Order was changed; reload and retry` / `Order was changed by another request; reload and retry` | Concurrency conflict. | GET current order then decide. |
| 409 | `PARTNER_BALANCE_CONFLICT` | `Partner balance changed; retry` | Concurrent account change. | GET account; retry safely. |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotency key was already used with a different request` | Same key, different JSON body. | Use original request/key or new key. |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotent request is still being processed; retry shortly` | Duplicate still running. | Retry same request/key shortly. |
| 410 | `QUOTES_DEPRECATED` | `Quote creation is deprecated; place a complete order directly` | Deprecated quote endpoint. | Use complete order. |
| 410 | `LEGACY_PARTNER_ORDER_DEPRECATED` | `Quote-based partner orders are disabled; submit a complete order using planId` | Quote-shaped create body. | Use current complete payload. |
| 410 | `HOSTED_PAYMENT_DEPRECATED` | Hosted-payment endpoint message explaining prepaid account requirement. | Hosted payment/`HOSTED_PAYMENT` request. | Collect customer payment yourself; use prepaid account. |
| 429 | `PARTNER_RATE_LIMITED` | `Partner rate limit exceeded` | Partner per-minute quota exceeded. | Back off; use returned rate headers. |
| 429 | `RATE_LIMITED` | `Too many requests. Please wait a moment and try again.` | Global rate guard. | Exponential backoff. |
| 503 | `HTTP_503` | `Private document storage is not configured` | Production private storage unavailable/config missing. | Stop document flow and contact Visa Compass. |
| 5xx | `UNEXPECTED` | Safe generic platform message | Unhandled server failure. | Retry only idempotent/safe work; give support correlation ID. |

## 18. Legacy endpoints (complete list; do not integrate)

| Method / URL | HTTP / code | Exact behavior | Replacement |
| --- | --- | --- | --- |
| POST `/partners/quotes` | 410 `QUOTES_DEPRECATED` | No quote is created. | `POST /partners/orders` complete payload. |
| POST `/partners/orders` with `quoteId` | 410 `LEGACY_PARTNER_ORDER_DEPRECATED` | No quote-based order is created. | Current `planId` payload. |
| POST `/partners/orders/{id}/traveler` | Deprecated | Legacy mutation; has `Deprecation: true` response header. | Include traveller in complete order. |
| POST `/partners/orders/{id}/documents` | Deprecated | Legacy upload route. | Upload-session route. |
| POST `/partners/orders/{id}/documents/{documentId}/confirm` | Deprecated | Legacy confirm route. | Upload-session + complete order. |
| POST `/partners/orders/{id}/hosted-checkout-session` | 410 `HOSTED_PAYMENT_DEPRECATED` | Never creates payment session. | Hosted checkout session route. |
| POST `/partners/orders/{id}/payment-session` | 410 `HOSTED_PAYMENT_DEPRECATED` | Never creates payment session. | Prepaid partner balance. |
