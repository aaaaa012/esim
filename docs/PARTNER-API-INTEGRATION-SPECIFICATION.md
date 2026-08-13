# Visa Compass Partner API Integration Guide

**API version:** v1  
**Audience:** approved Visa Compass partners and their integration teams  
**Verified against the implementation:** 2026-08-13

## 1. About this API

This document explains how approved partners can integrate with the Visa Compass API to sell and manage eSIMs for their travellers.

You can use the API to:

- check which eSIM plans are available;
- collect and upload the traveller's required documents;
- create an eSIM order using your prepaid Visa Compass partner balance;
- track fulfilment while Visa Compass prepares the eSIM;
- retrieve the eSIM activation package when it is ready;
- review usage, account balance, ledger activity, order events, cancellations, refund requests and notifications.

Creating an order does not mean the eSIM is ready immediately. Provisioning happens in the background. Your system must check the order status, or receive a webhook, and retrieve activation details only when the order is `QR_READY` or `COMPLETED`.

There are two integration options:

1. **API integration (`API`)** — your application collects traveller details and documents, then creates a complete order through the API.
2. **Hosted checkout (`CHECKOUT_LINK`)** — your application creates a secure checkout link. The traveller completes the Visa Compass-hosted traveller and document flow.

Partners use `PARTNER_ACCOUNT` settlement. You collect payment from your traveller and Visa Compass debits your prepaid balance in NPR paisa. `HOSTED_PAYMENT` endpoints remain only for backwards compatibility and return `410 Gone`; do not build against them.

## 2. Environment and base URL

All paths in this guide are relative to:

```text
<base-url>/api/v1
```

| Environment | Address |
| --- | --- |
| UAT / sandbox | **[REQUIRES BUSINESS CONFIRMATION]** The code does not contain a fixed UAT URL. Visa Compass will provide it during onboarding. |
| Production | `API_PUBLIC_URL` plus `/api/v1`. The real host is deployment configuration and is not stored in source code. |

Production runs with production-only secrets. Simulator behaviour is rejected when `NODE_ENV=production`. Obtain your assigned URL, credentials and test plan through an approved secure channel.

## 3. Authentication and common request rules

### 3.1 How you authenticate

Every `/partners` endpoint needs a partner bearer credential:

```http
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

The API finds the `<key-prefix>`, hashes the supplied secret with SHA-256, and compares it with the stored hash using a timing-safe comparison. The key prefix contains 8–32 URL-safe characters after `vc_partner_`.

There is **no inbound request HMAC, timestamp, nonce, or separate API-secret signing string** in the current Partner API. The bearer credential is the authentication method.

Keep the whole value in your server-side secret manager. Do not place it in browser code, a mobile app, URLs, logs, screenshots or support tickets.

```http
Authorization: Bearer vc_partner_agencyabc.7hAqz4...secret...
Content-Type: application/json
x-idempotency-key: 46b5b3f8-0e98-4bb7-884d-d2fbd5938d14
x-correlation-id: partner-trace-1042
```

```js
await fetch(`${baseUrl}/api/v1/partners/plans?country=JP`, {
  headers: {
    Authorization: `Bearer ${process.env.VISA_COMPASS_PARTNER_KEY}`
  }
});
```

### 3.2 Scopes

Visa Compass gives each credential only the access it needs.

| Scope | What it allows |
| --- | --- |
| `catalog:read` | Capabilities, plans and the deprecated quote/payment routes. |
| `documents:write` | Document upload sessions and legacy document routes. |
| `orders:read` | Order reads, account, ledger and events. |
| `orders:write` | Complete orders, cancellation, notifications and legacy traveller route. |
| `checkout:write` | Hosted-checkout session creation. |
| `esims:read` | eSIM activation package retrieval. |
| `refunds:write` | Refund-request submission. |
| `usage:read` | Usage retrieval. |

An invalid, expired or revoked credential returns `401 PARTNER_UNAUTHORIZED`. A valid key without the needed scope returns `403 PARTNER_SCOPE_FORBIDDEN`. A suspended partner can still use `GET` requests, but a mutation returns `403 PARTNER_SUSPENDED`.

### 3.3 Request and response rules

| Rule | What to do |
| --- | --- |
| Content type | Send `Content-Type: application/json` for JSON POST requests. API JSON is UTF-8. |
| Dates | Use ISO 8601 date-time values for timestamps, for example `2026-08-13T08:30:00.000Z`. Use `YYYY-MM-DD` for date of birth and passport expiry. |
| Money | Amounts are integer `amountPaisa`. `100` paisa equals NPR 1. Currency is `NPR`. |
| IDs | Use UUID values unless a field description says otherwise. |
| Idempotency | Send `x-idempotency-key` on every POST. The key must be 8–200 characters. Keep the same key if you retry the same action. |
| Correlation | You may send `x-correlation-id`. The API returns it, or creates one, so you can trace support issues. |
| Rate limiting | Read `x-ratelimit-limit`, `x-ratelimit-remaining` and `retry-after` response headers. |
| IP allowlisting | **[REQUIRES BUSINESS CONFIRMATION]** It is not implemented for partners. |
| Client timeout | The API does not publish an inbound timeout. Use a prudent client timeout such as 10 seconds, then reconcile an unknown result. |

Every success response has this shape:

```json
{"data":{},"meta":{"correlationId":"d7145d5c-5233-409c-bb38-4dc2c82d9707","timestamp":"2026-08-13T08:30:00.000Z"}}
```

Every error response has this shape:

```json
{"data":null,"error":{"code":"VALIDATION_ERROR","message":"traveler.email: Invalid email address","details":[{"field":"traveler.email","message":"Invalid email address"}]},"meta":{"correlationId":"d7145d5c-5233-409c-bb38-4dc2c82d9707","timestamp":"2026-08-13T08:30:00.000Z"}}
```

Use `error.code` in code. Show `error.message` to a user where appropriate. `details` is supplied for schema-validation errors.

## 4. Endpoint list

| # | Endpoint | Method | Why you use it | When to call it |
| --- | --- | --- | --- | --- |
| 1 | `/partners/capabilities` | GET | Check enabled commercial/API features. | During setup or before selecting a flow. |
| 2 | `/partners/plans?country=XX` | GET | List plans your partner can sell. | Before showing a plan to a traveller. |
| 3 | `/partners/document-upload-sessions` | POST | Create private upload instructions. | Before a complete API order. |
| 4 | `/partners/orders` | POST | Validate, fund and create a complete order. | After document bytes have uploaded. |
| 5 | `/partners/orders` | GET | List your own orders. | Reconciliation and support. |
| 6 | `/partners/orders/{id}` | GET | Check one order. | Poll fulfilment. |
| 7 | `/partners/orders/by-external-id/{externalOrderId}` | GET | Recover an order using your reference. | After timeout/unknown POST result. |
| 8 | `/partners/orders/{id}/esim` | GET | Retrieve the activation package. | Only at `QR_READY` or `COMPLETED`. |
| 9 | `/partners/orders/{id}/usage` | GET | Read provider usage. | After `COMPLETED`. |
| 10 | `/partners/orders/{id}/events` | GET | Read partner event history. | Reconciliation/support. |
| 11 | `/partners/orders/{id}/cancel` | POST | Cancel an eligible order. | Before fulfilment where permitted. |
| 12 | `/partners/orders/{id}/refund-requests` | POST | Ask Operations to decide a refund. | A qualifying exception. |
| 13 | `/partners/orders/{id}/notifications` | POST | Request an order, QR or reupload message. | Traveller support. |
| 14 | `/partners/account` | GET | Read prepaid balance and summary. | Before/after sales. |
| 15 | `/partners/ledger` | GET | Reconcile financial entries. | Finance/support. |
| 16 | `/partners/hosted-checkout-sessions` | POST | Start token-based hosted checkout. | Instead of the API order flow. |
| 17–21 | `/partner-checkout/{token}…` | GET/POST | Hosted traveller/document/complete steps. | Traveller uses returned link. |
| 22–28 | Legacy routes in section 6.8 | POST | Old split-order/payment routes. | Do not use for new integration. |

## 5. Data you will send

### 5.1 Traveller

You send this object when creating a complete API order and when updating a hosted-checkout traveller.

| Field | Required / allowed values | What it means |
| --- | --- | --- |
| `title` | Yes: `MR`, `MS`, `MRS` | Traveller title. |
| `firstName`, `surname` | Yes: 1–80 chars | Given and family names. |
| `middleName` | Optional: max 80 chars | Middle name. |
| `dateOfBirth` | Yes: past `YYYY-MM-DD` | Date of birth. |
| `nationality`, `countryOfResidence` | Yes: exactly two chars | Country codes. |
| `city` | Yes: 1–100 chars | City. |
| `employerOrBusinessName` | Optional: max 160 chars | Employer or business. |
| `email` | Yes: valid email | Delivery contact. |
| `mobile` | Yes: 7–20 chars; digits, spaces, hyphens, optional leading `+` | Delivery contact. |
| `passportNumber` | Yes: 5–30 letters, numbers or hyphen | Passport identifier. |
| `passportExpiryDate` | Yes: future `YYYY-MM-DD` | Passport expiry date. |
| `pointOfSaleCode` | Optional: max 40 chars | Your point-of-sale reference. |

### 5.2 Documents

Document types are `PASSPORT`, `TICKET` and `VISA`. An upload session accepts 1–3 unique types. A complete order accepts 2–3 unique upload references and must include the document types required by the selected plan. Passport and ticket are normally required. VISA is required only if the deployment's `VISA_REQUIRED_COUNTRIES` configuration includes the destination.

Each upload declaration needs a filename of 1–180 characters, content type `application/pdf`, `image/jpeg`, or `image/png`, and `sizeBytes` from 1 to 10 MiB. The server checks the actual private asset type and size before it accepts the order.

## 6. Endpoint reference

All `/partners` APIs need the bearer credential in section 3. Send `x-idempotency-key` on each POST.

### 6.1 `GET /partners/capabilities`

**What it is for.** This lets you discover the features available to your partner before you choose an integration behaviour.

**When to call it.** Call it during setup and after a commercial configuration change.

**What to send.** No body. Scope: `catalog:read`.

**What the response means / next step.** It returns `apiVersion`, `currency`, `settlementMethods`, `payments`, `notifications`, `connectivity`, `idempotencyRequiredForMutations` and `outboundWebhooks`. Use these values before assuming a capability is enabled.

**What can go wrong.** Authentication, scope and rate-limit errors follow section 7.

**Example response data.**

```json
{"apiVersion":"v1","currency":"NPR","settlementMethods":["PARTNER_ACCOUNT"],"payments":[],"notifications":["EMAIL","WHATSAPP"],"connectivity":{"available":true},"idempotencyRequiredForMutations":true,"outboundWebhooks":true}
```

### 6.2 `GET /partners/plans?country=JP`

**What it is for.** Use this to show sellable plans. It protects you from selling an inactive plan or using an old price.

**When to call it.** Call before the traveller selects a plan. The `country` filter is optional and is normalised to uppercase by the API.

**What to send.** Scope: `catalog:read`. Optional query: `country`.

**What the response means / next step.** Save the returned `id` for `POST /partners/orders`. Display `price.amountPaisa`, `currency`, plan coverage/validity and `requiredDocuments`; do not rely on a locally cached price.

**What can go wrong.** An empty result means no matching active plan is available. Authentication/scope/rate-limit errors are described in section 7.

**Example response data.**

```json
{"id":"8d048c3f-1052-4d58-8837-09c02d86bb77","countryCode":"JP","name":"Japan 5 GB / 15 Days","dataAllowance":"5 GB","validityDays":15,"price":{"amountPaisa":249900,"currency":"NPR"},"requiredDocuments":["PASSPORT","TICKET"],"availability":"AVAILABLE"}
```

### 6.3 `POST /partners/document-upload-sessions`

**What it is for.** This creates short-lived, private document-upload instructions. Document bytes go to the returned storage provider, not through the order API.

**When to call it.** Call it before a complete API order, after you know the partner `externalOrderId`.

**What to send.** Scope: `documents:write`, idempotency key, and this request:

```json
{"externalOrderId":"agency-order-1042","documents":[{"type":"PASSPORT","fileName":"passport.pdf","contentType":"application/pdf","sizeBytes":282143},{"type":"TICKET","fileName":"ticket.jpg","contentType":"image/jpeg","sizeBytes":113822}]}
```

`externalOrderId` is 1–120 chars. `documents` contains 1–3 unique types. Each file uses the rules in section 5.2.

**What the response means / next step.** Each response item has an `uploadId`, expiry and provider-specific `upload` instructions. Upload the bytes directly using those instructions. Keep each `uploadId` and send it in the complete-order request.

**What can go wrong.** A declared file that expires, belongs to another external order, has been consumed, has a different actual type, or has a different actual size is rejected when the order is created.

**Example response data.**

```json
{"externalOrderId":"agency-order-1042","documents":[{"uploadId":"d5f1f947-1a93-45af-8a9d-776d0c29db6a","type":"PASSPORT","fileName":"passport.pdf","expiresAt":"2026-08-13T08:45:00.000Z","upload":{}}]}
```

### 6.4 `POST /partners/orders`

**What it is for.** This is the main API-order call. It validates the plan, traveller, consent and verified uploads; creates the customer/order; records consent; debits the partner account; and starts background provisioning.

**When to call it.** Call only after all required document bytes have uploaded successfully.

**What to send.** Scope: `orders:write`, idempotency key, and a complete order:

```json
{"externalOrderId":"agency-order-1042","externalCustomerId":"customer-91","planId":"8d048c3f-1052-4d58-8837-09c02d86bb77","settlement":{"method":"PARTNER_ACCOUNT"},"traveler":{"title":"MR","firstName":"Samir","surname":"Majhi","dateOfBirth":"1995-01-01","nationality":"NP","city":"Kathmandu","countryOfResidence":"NP","email":"samir@example.com","mobile":"+9779800000000","passportNumber":"PA1234567","passportExpiryDate":"2030-01-01"},"documents":[{"type":"PASSPORT","uploadId":"d5f1f947-1a93-45af-8a9d-776d0c29db6a"},{"type":"TICKET","uploadId":"42f04c68-1666-4c1b-88dc-08f2be5a7e08"}],"consent":{"compatibilityAccepted":true,"termsAccepted":true,"privacyAccepted":true,"acceptedAt":"2026-08-13T08:30:00.000Z"},"metadata":{"branch":"KTM-01"}}
```

`externalOrderId` and `externalCustomerId` are 1–120 chars. `planId` comes from plans. `metadata` is an optional string-to-string map, with values up to 500 chars; never put sensitive personal data or secrets in it. `settlement` defaults to `PARTNER_ACCOUNT`. Do not send `HOSTED_PAYMENT`. All three consent fields must be `true`.

**What the response means / next step.** The response is a normalised order with its `id`, `orderNumber`, partner references, plan/pricing snapshot, `status`, `fulfillmentStatus`, timestamps and links. It normally starts at `APPROVED` or `PROVISIONING`. Poll the order or wait for a webhook until `fulfillmentStatus` becomes `READY` or `ACTIVATED`.

**What can go wrong.** Common business failures are `PLAN_UNAVAILABLE`, `DOCUMENT_REQUIRED`, `DOCUMENTS_REQUIRED`, `INSUFFICIENT_PARTNER_BALANCE`, `INVENTORY_UNAVAILABLE`, `ORDER_INVALID_STATE`, and upload validation failures. Do not create another order after an uncertain result; follow section 8.

### 6.5 Order, eSIM, usage and event reads

| API | What it is for | When / what to send | What response means / next step | What can go wrong | Example response |
| --- | --- | --- | --- | --- | --- |
| `GET /partners/orders` | Lists only your orders. | `orders:read`; optional UUID `cursor`, `status`, `externalOrderId` max 120, `limit` 1–100. | `{items,nextCursor}`. Pass `nextCursor` to read the next page. | See section 7. | `{"items":[],"nextCursor":null}` |
| `GET /partners/orders/{id}` | Checks one Visa Compass order. | `orders:read`; order UUID. | Read `status` and `fulfillmentStatus`; poll until ready/activated. | A missing or other partner's order returns `PARTNER_ORDER_NOT_FOUND` / `ORDER_NOT_FOUND`. | Normalised order described in 6.4. |
| `GET /partners/orders/by-external-id/{externalOrderId}` | Finds an order using your own reference. | `orders:read`; your external ID. | Use after a timed-out/unknown create request before retrying. | Same ownership/not-found rules. | Normalised order. |
| `GET /partners/orders/{id}/esim` | Retrieves sensitive activation details. | `esims:read`; only after `QR_READY` or `COMPLETED`. | Delivers `iccid`, optional `msisdn`, `smDpAddress`, sensitive `activationCode`, `activatedAt`, `expiresAt`. Deliver safely to the entitled traveller only. | Before ready, the order is not ready; never log activation details. | `{"orderId":"a7b2dd01-b5a8-4dd3-a4cb-497e362bc012","status":"QR_READY","fulfillmentStatus":"READY","iccid":"8988...","activationCode":"LPA:1$...","activatedAt":null,"expiresAt":"2026-08-28T00:00:00.000Z"}` |
| `GET /partners/orders/{id}/usage` | Reads current provider usage. | `usage:read`; order must be `COMPLETED`. | Typical data is `usedMb` and `totalMb`. | Before activation, code may return `PARTNER_USAGE_UNAVAILABLE`; provider problems can return `USAGE_UNAVAILABLE`. | `{"usedMb":512,"totalMb":5120}` |
| `GET /partners/orders/{id}/events` | Shows partner event history. | `orders:read`; order UUID. | Use for reconciliation/support. | See section 7. | `{"id":"b8da...","type":"order.accepted","version":"1.0","resourceId":"a7b2dd01-b5a8-4dd3-a4cb-497e362bc012","correlationId":"...","payload":{},"occurredAt":"2026-08-13T08:30:00.000Z"}` |

### 6.6 Cancellation, refund and notification requests

| API | What it is for | When / what to send | What response means / next step | What can go wrong | Example request |
| --- | --- | --- | --- | --- | --- |
| `POST /partners/orders/{id}/cancel` | Attempts to cancel an eligible order. | `orders:write`, idempotency key, `{"reason":"…"}` where reason is 3–1000 chars. | Reconcile the returned order status. | A state that cannot be cancelled returns a state/business error. | `{"reason":"Traveller cancelled before fulfilment"}` |
| `POST /partners/orders/{id}/refund-requests` | Creates a request for an Operations refund decision; it is not an immediate payment-gateway refund. | `refunds:write`, idempotency key, same reason object. | Monitor order/account/ledger and your support process. | Eligibility and financial decision are not automatic. | `{"reason":"Provisioning could not be completed"}` |
| `POST /partners/orders/{id}/notifications` | Asks Visa Compass to send a message to the stored traveller contact. | `orders:write`, idempotency key, `channel` is `EMAIL` or `WHATSAPP`; `template` is `ORDER_STATUS`, `QR_READY`, or `DOCUMENT_REUPLOAD`. | Delivery is queued. | You cannot supply an arbitrary recipient. Notification/provider failures are asynchronous. | `{"channel":"EMAIL","template":"ORDER_STATUS"}` |

### 6.7 Hosted checkout APIs

**What it is for.** Hosted checkout is for a partner that does not want to build its own traveller and document pages.

**When to call it.** Use this instead of the API order flow, and only when your partner is configured as `CHECKOUT_LINK`.

**What to send.** `POST /partners/hosted-checkout-sessions` needs `checkout:write`, an idempotency key, `planId` UUID, `externalOrderId` (1–120), `externalCustomerId` (1–120), and optional `topUpMobile` (max 20).

**What the response means / next step.** It creates a `DRAFT` and returns a short-lived checkout URL/token. Send that URL only to the intended traveller.

**What can go wrong.** A non-`CHECKOUT_LINK` partner receives `INTEGRATION_TYPE_FORBIDDEN`.

The traveller then uses these token-authorised APIs:

| API | What it does | Request |
| --- | --- | --- |
| `GET /partner-checkout/{token}` | Reads hosted checkout. | Token in path. |
| `GET /partner-checkout/{token}/documents` | Reads hosted documents. | Token in path. |
| `POST /partner-checkout/{token}/traveler` | Saves traveller details. | Traveller object from section 5.1. |
| `POST /partner-checkout/{token}/documents` | Starts hosted document handling. | `{"type":"PASSPORT|TICKET|VISA","fileName":"…"}`. |
| `POST /partner-checkout/{token}/documents/{documentId}/confirm` | Confirms a document. | Token and document UUID. |
| `POST /partner-checkout/{token}/verify-passport` | Runs passport verification. | Token. |
| `POST /partner-checkout/{token}/complete` | Completes hosted checkout. | `{"consentAccepted":true}`. |

**[PARTIALLY IMPLEMENTED]** The hosted document-upload exchange is provider-shaped. Test the actual returned instructions in UAT before production use.

### 6.8 Deprecated APIs — do not use for a new integration

| API | Current result | What to use instead |
| --- | --- | --- |
| `POST /partners/quotes` | `410 QUOTES_DEPRECATED` | Complete `POST /partners/orders`. |
| `POST /partners/orders/{id}/hosted-checkout-session` | `410 HOSTED_PAYMENT_DEPRECATED` | Include `settlement.method = "PARTNER_ACCOUNT"` when creating an order. |
| `POST /partners/orders/{id}/payment-session` | `410 HOSTED_PAYMENT_DEPRECATED` | Include `settlement.method = "PARTNER_ACCOUNT"` when creating an order. |
| `POST /partners/orders/{id}/traveler`, `/documents`, `/documents/{documentId}/confirm` | Marked deprecated. | Upload sessions plus complete `POST /partners/orders`. |

## 7. Statuses, errors and partner action

### 7.1 Order statuses

| Status | What it means | What you should do next |
| --- | --- | --- |
| `DRAFT` | Hosted checkout is incomplete. | Traveller must complete it or it expires. |
| `PAYMENT_PENDING`, `PAYMENT_CONFIRMED` | Direct-customer payment states; not normal for prepaid Partner API orders. | Reconcile only if returned. |
| `REVIEW_PENDING`, `AWAITING_CUSTOMER` | Review or replacement-document work is needed. | Wait for review or ask traveller to provide requested data. |
| `APPROVED`, `PROVISIONING` | Funds accepted and eSIM work is pending/running. | Poll or wait for webhook. |
| `QR_READY` | Activation package is available. | Retrieve `/esim` securely. |
| `COMPLETED` | Provider confirmed activation. | Usage may now be queried. |
| `PAYMENT_FAILED`, `CANCELLED` | No fulfilment will happen. | Inspect order/events before any new sale. |
| `PROVISIONING_FAILED` | eSIM provisioning failed and needs Operations handling. | Do not create a duplicate; contact support/reconcile. |
| `REFUND_PENDING`, `REFUNDED` | Refund is awaiting/has received a decision. | Check account/ledger and agreed support process. |

`fulfillmentStatus` makes delivery state simpler: `PENDING` for `APPROVED`/`PROVISIONING`, `READY` for `QR_READY`, `ACTIVATED` for `COMPLETED`, `FAILED` for `PROVISIONING_FAILED`, otherwise `NOT_READY`.

### 7.2 Error guide

| HTTP / code | What it means | What you should do |
| --- | --- | --- |
| 400 `VALIDATION_ERROR` | The request has invalid or missing data. The `details` array identifies fields. | Correct the request. Use a new idempotency key only if the body changes. |
| 400 `INSUFFICIENT_PARTNER_BALANCE` | Your prepaid balance cannot fund the order. | Fund the account, then create a new eligible request. |
| 401 `PARTNER_UNAUTHORIZED` | Credential is missing, malformed, invalid, expired or revoked. | Check/rotate the server-side credential. |
| 403 `PARTNER_SCOPE_FORBIDDEN` | Your key does not have the required scope. | Ask Visa Compass to grant the scope. |
| 403 `PARTNER_SUSPENDED` | Your partner account cannot make mutations. | Contact Visa Compass support. |
| 404 `PARTNER_ORDER_NOT_FOUND` / `ORDER_NOT_FOUND` | Order is missing or is not owned by your partner. | Check the identifier and account. |
| 409 idempotency/balance conflict | Same key has a different body, an action is still running, an external order is duplicate, or balance changed concurrently. | Query by `externalOrderId`; retry only after the outcome is known. |
| 410 `QUOTES_DEPRECATED` / `HOSTED_PAYMENT_DEPRECATED` | You called a retired API. | Move to the supported prepaid flow. |
| 429 `PARTNER_RATE_LIMITED` / `RATE_LIMITED` | Too many requests. | Wait for `retry-after` and lower request concurrency. |
| 5xx `UNEXPECTED` | A safe internal or provider error was returned. | Do not duplicate the order. Query first and give support the correlation ID. |

Shared-service business codes may also be returned: `PLAN_NOT_AVAILABLE`, `PLAN_UNAVAILABLE`, `DOCUMENT_REQUIRED`, `DOCUMENTS_REQUIRED`, `DOCUMENT_NOT_FOUND`, `ORDER_INVALID_STATE`, `ORDER_IMMUTABLE`, `INVENTORY_UNAVAILABLE`, `PROVISIONING_FAILED`, `PROVISIONING_DELAYED`, `USAGE_UNAVAILABLE`, `CONNECTIVITY_UNAVAILABLE`, and `DOCUMENT_STORAGE_UNAVAILABLE`. The API response message is the authoritative user-safe explanation.

**[DOCUMENTATION/CODE MISMATCH]** Some specialised partner-service codes are not declared in the shared error-code catalogue. Build handling around HTTP status and returned `error.code`; do not assume any static list is exhaustive.

## 8. Timeouts, retries and webhooks

If `POST /partners/orders` times out, the connection drops, you receive an empty response, or you receive a 5xx response, the order may still have been created and the balance may already have been debited. Do not create another order immediately.

1. Call `GET /partners/orders/by-external-id/{externalOrderId}`.
2. If it exists, use that order.
3. If it does not exist, repeat the identical request with the same idempotency key.
4. For `429`, wait for `retry-after`.
5. For a provisioning delay, poll order/events or wait for webhook. Do not submit a second order.

Visa Compass sends outbound webhooks only to an endpoint registered by Operations. The body is:

```json
{"id":"event-uuid","partnerId":"partner-uuid","type":"order.accepted","version":"1.0","resourceId":"order-uuid","occurredAt":"2026-08-13T08:30:00.000Z","correlationId":"uuid","data":{}}
```

| Header | Meaning |
| --- | --- |
| `vc-event-id` | Unique event ID. Deduplicate on this value. |
| `vc-webhook-timestamp` | Unix seconds. |
| `vc-webhook-signature` | `v1=<hex>` HMAC-SHA256 signature. |

Verify the signature by calculating HMAC-SHA256 with the endpoint secret over exactly:

```text
<timestamp>.<raw JSON body>
```

Return any 2xx response quickly. Delivery has a 10-second timeout and retries up to three times with 2/4-second exponential delay. Treat it as at-least-once delivery. Registered endpoint filters can be `*` or specific event types. **[REQUIRES BUSINESS CONFIRMATION]** The implementation does not publish a stable external event-type catalogue/version guarantee.

## 9. Security and go-live checklist

- Use HTTPS. Partner IP allowlisting is not implemented.
- Store the API credential and webhook secret only in server-side secret management.
- Rotate credentials by issuing a second key, moving traffic, then revoking the old key.
- Do not log passport values, documents, activation code, ICCID or MSISDN.
- Verify webhook HMAC against the raw body and deduplicate `vc-event-id`.

Before development, obtain a scoped credential, URL, UAT plan, partner type, funded account and webhook secret. During development, test plan discovery, private upload, complete order, order polling, idempotency, timeout recovery, webhook verification and eSIM retrieval only at ready state. Before production, complete UAT, confirm production credentials/URL/webhook endpoint, test monitoring/reconciliation and agree the support/refund escalation process.
