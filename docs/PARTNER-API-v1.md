# Visa Compass Partner API v1

This is the partner-facing, server-to-server integration specification. It covers the REST API that Visa Compass exposes to API partners. It excludes hosted checkout, internal administration, customer web APIs, and provider callbacks.

**Base URL:** `https://<api-host>/api/v1`  
**Partner API prefix:** `/partners`  
**Currency:** NPR; all amounts are integer paisa (`250000` = NPR 2,500.00).

## 1. Integration flow

### Initial eSIM purchase

```text
1. GET  /partners/capabilities
2. GET  /partners/plans?country=JP
3. POST /partners/document-upload-sessions
4. PUT  each file to its returned signed upload URL
5. POST /partners/document-verifications/{verificationId}/documents/{documentId}/confirm
6. GET  /partners/document-verifications/{verificationId} until orderCreationAllowed=true
7. POST /partners/orders (creates a `REVIEW_PENDING` order; no debit or provisioning yet)
8. GET  /partners/document-verifications/{verificationId} or the order until fulfillmentAllowed=true
9. POST /partners/orders/{id}/finalize
10. GET /partners/orders/{id}, receive webhook, or both
11. GET /partners/orders/{id}/esim when status is QR_READY, ACTIVATION_ATTENTION, or COMPLETED
```

### Existing eSIM top-up

```text
1. GET  /partners/plans?country=JP
2. POST /partners/orders with purchaseType=TOPUP and topUpMobile set to the existing eSIM's MSISDN
3. GET  /partners/orders/{id}, receive webhook, or both
```

Top-ups do not use document-upload sessions or `documentVerificationId`.

## 2. Authentication, headers, and envelopes

All partner endpoints require:

```http
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

Send `Accept: application/json` to request a JSON response.

Every partner `POST` requires:

```http
Idempotency-Key: <unique-8-to-200-character-key>
```

Send `Content-Type: application/json` when the request has a JSON body. The confirmation and finalize endpoints have no body.

Use the **same** idempotency key and identical body only when retrying an uncertain request. Use a new key for a new business action. Keys are retained for 24 hours.

Optional `X-Correlation-Id` is returned in `X-Correlation-Id` and in the response body. Authenticated responses also include `X-RateLimit-Limit` and `X-RateLimit-Remaining`. A `429` response includes `Retry-After` in seconds.

Every success is wrapped as:

```json
{
  "data": {},
  "meta": {
    "correlationId": "a1d5a94c-1836-4eb1-9da5-a2377cf30001",
    "timestamp": "2026-08-31T04:15:00.000Z"
  }
}
```

Every error is wrapped as:

```json
{
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "documents.0.sizeBytes: Number must be less than or equal to 10485760",
    "details": [
      {
        "field": "documents.0.sizeBytes",
        "message": "Number must be less than or equal to 10485760"
      }
    ]
  },
  "meta": {
    "correlationId": "a1d5a94c-1836-4eb1-9da5-a2377cf30001",
    "timestamp": "2026-08-31T04:15:00.000Z"
  }
}
```

Use `error.code` and HTTP status in your application logic. Keep the correlation ID for support.

All JSON examples use illustrative UUIDs, dates, prices, names, and secrets. The field names, nesting, types, nullability shown, and envelope are taken from the implementation. Fields marked optional may be absent or `null` when the underlying order/session does not have that value.

### Shared errors

| HTTP | Code | Message | Action |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Field-specific validation text | Correct the named field and create a new request/key. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | `Idempotency-Key is required for partner mutations` | Add the header. |
| 400 | `INVALID_IDEMPOTENCY_KEY` | `Invalid idempotency key` | Use an 8-200 character key. |
| 401 | `PARTNER_UNAUTHORIZED` | `Your API key is invalid.` or `Your API key is invalid or has expired.` | Stop; correct or rotate the credential. |
| 403 | `PARTNER_SCOPE_FORBIDDEN` | `Your API key is not allowed to use this endpoint. Contact support to request access.` | Request the endpoint scope from Visa Compass. |
| 403 | `PARTNER_SUSPENDED` | `Your partner account is suspended. Contact support for help.` | Contact Visa Compass; do not retry mutations. |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotency key was already used with a different request` | Never change request content under an existing key. |
| 409 | `IDEMPOTENCY_CONFLICT` | `Idempotent request is still being processed; retry shortly` | Retry the exact request/key after a short delay. |
| 429 | `PARTNER_RATE_LIMITED` | `Too many requests. Please wait and try again.` | Wait `Retry-After`, then retry with backoff. |
| 500 | `UNEXPECTED` | `Something went wrong. Please try again.` | Retry only with bounded backoff; supply correlation ID to support if persistent. |

## 3. Access scopes

| Scope | Endpoints |
| --- | --- |
| `catalog:read` | Capabilities and plans |
| `documents:write` | Document upload sessions, confirmation, verification lookup |
| `orders:read` | Orders, events, account, ledger |
| `orders:write` | Create order, cancel, notifications |
| `esims:read` | eSIM details |
| `usage:read` | Usage |
| `refunds:write` | Refund requests |

## 4. Response field reference

Examples below use illustrative IDs, dates, and prices; their field names, nesting, and envelopes match the implementation. Optional fields can be absent or `null` when no value exists.

| Response field | Meaning |
| --- | --- |
| upload session `verificationId` | Send as `documentVerificationId` when creating an initial order. |
| upload session `documents[].id` | Use as `documentId` when confirming that upload. |
| upload session `documents[].upload` | Direct-upload instructions; `endpoint` is short-lived and sensitive. |
| verification `orderCreationAllowed` | Authoritative permission to submit an initial order. |
| verification/order `fulfillmentAllowed` | Authoritative permission to finalize the pending initial order and debit the partner account. |
| verification `consumedAt` | Non-null means it has already been used for an order. |
| order `id` | Visa Compass order ID for all `/orders/{id}` endpoints. |
| order `externalOrderId` | Partner sale ID for reconciliation and lookup. |
| order `totalAmountPaisa` | Final debit amount in paisa. |
| order `links` | Relative API paths; prefix with the API host. |
| order `esimDetailsAvailable` | Whether eSIM details may be retrieved. |
| order `documentReviewPolicy` / `documentReviewStatus` | Configured review path and the current document-review state. |
| order `documents` | Document summaries for the order. They include review state but never include upload URLs or file contents. |
| eSIM `activationCode`, `iccid`, `msisdn` | Sensitive activation data; never log it. |
| ledger `amountPaisa` / `balanceAfterPaisa` | Entry amount and resulting balance. |
| event `id` | Durable event ID; use for webhook deduplication. |
| refund decision fields | `decidedById` and `decidedAt` are null until a decision. |
| notification `status` | `QUEUED` confirms queue acceptance, not delivery to the traveler. |

## 5. Catalogue endpoints

### 5.1 Capabilities

**Scope:** `catalog:read`  
**Request:**

```http
GET /api/v1/partners/capabilities
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response:**

```json
{
  "data": {
    "apiVersion": "v1",
    "currency": "NPR",
    "settlementMethods": ["PARTNER_ACCOUNT"],
    "payments": [],
    "notifications": ["EMAIL", "WHATSAPP"],
    "connectivity": { "available": true },
    "idempotencyRequiredForMutations": true,
    "outboundWebhooks": true
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:00.000Z" }
}
```

Use `settlementMethods` to determine permitted settlement; `PARTNER_ACCOUNT` is the only supported method. If `connectivity.available` is false, do not create a new sale until it recovers or Visa Compass instructs otherwise.

**Relevant failures:** shared authentication, scope, rate-limit, and server errors only.

### 5.2 List plans

**Scope:** `catalog:read`  
**Request:**

```http
GET /api/v1/partners/plans?country=JP
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

`country` is optional. The implementation uppercases it and matches it to an active plan's country code; an unmatched value returns an empty array rather than a validation error. Send an ISO two-letter country code.

**200 response:**

```json
{
  "data": [
    {
      "id": "10000000-0000-4000-8000-000000000001",
      "countryCode": "JP",
      "countryName": "Japan",
      "name": "Japan 10 GB / 30 days",
      "dataAllowance": "10 GB",
      "validityDays": 30,
      "coverage": "Japan",
      "destination": { "countryCode": "JP", "countryName": "Japan" },
      "price": { "amountPaisa": 250000, "currency": "NPR" },
      "requiredDocuments": ["PASSPORT", "TICKET"],
      "availability": "AVAILABLE",
      "compatibilityDisclaimer": "The traveler must confirm that the destination device supports eSIM before purchase.",
      "refundSummary": "Refund eligibility depends on payment, review, provisioning, and activation status.",
      "updatedAt": "2026-08-30T12:00:00.000Z",
      "currency": "NPR"
    }
  ],
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:01.000Z" }
}
```

**Carry forward:** use `data[].id` as `planId`; use `data[].requiredDocuments` when declaring documents. Use `price.amountPaisa` only for display/reconciliation; the server calculates the definitive debit when the order is created.

**Relevant failures:** shared errors only. An empty array means no active plan matches; it is not an error.

## 6. Initial purchase: documents and verification

### 6.1 Create document-upload session

**Scope:** `documents:write`  
**Request:**

```http
POST /api/v1/partners/document-upload-sessions
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-documents-v1
Content-Type: application/json

{
  "externalOrderId": "agency-order-1042",
  "traveler": {
    "title": "MS",
    "firstName": "Asha",
    "surname": "Shrestha",
    "dateOfBirth": "1990-05-14",
    "nationality": "NP",
    "city": "Kathmandu",
    "countryOfResidence": "NP",
    "email": "asha@example.com",
    "mobile": "+9779812345678",
    "passportNumber": "PA1234567",
    "passportExpiryDate": "2030-05-14"
  },
  "documents": [
    { "type": "PASSPORT", "fileName": "passport.pdf", "contentType": "application/pdf", "sizeBytes": 483120 },
    { "type": "TICKET", "fileName": "ticket.jpg", "contentType": "image/jpeg", "sizeBytes": 342991 }
  ]
}
```

**Request fields:**

| Field | Required | Rules |
| --- | --- | --- |
| `externalOrderId` | Yes | Your unique sale ID, 1-120 characters. Reuse it in §7.1. |
| `traveler.title` | Yes | `MR`, `MS`, or `MRS`. |
| `traveler.firstName`, `surname`, `city` | Yes | Trimmed non-empty strings. |
| `traveler.dateOfBirth` | Yes | ISO date in the past. |
| `traveler.nationality`, `countryOfResidence` | Yes | Two-character country codes. |
| `traveler.email`, `mobile` | Yes | Valid email; phone-like 7-20 character number. |
| `traveler.passportNumber`, `passportExpiryDate` | Yes | Passport number 5-30 alphanumeric/hyphen chars; future ISO expiry date. |
| `traveler.middleName`, `employerOrBusinessName`, `pointOfSaleCode` | No | Optional values. |
| `documents` | Yes | 2-3 unique entries. Must include `PASSPORT` and `TICKET`; `VISA` is accepted as the optional third entry. |
| `documents[].type` | Yes | `PASSPORT`, `TICKET`, or `VISA`. |
| `documents[].fileName` | Yes | 1-180 characters. |
| `documents[].contentType` | Yes | `application/pdf`, `image/jpeg`, or `image/png`. |
| `documents[].sizeBytes` | Yes | Integer from 1 through 10,485,760. |

**201 response:**

```json
{
  "data": {
    "verificationId": "20000000-0000-4000-8000-000000000001",
    "externalOrderId": "agency-order-1042",
    "status": "AWAITING_UPLOAD",
    "expiresAt": "2026-09-01T04:15:02.000Z",
    "checkoutReleaseAt": "2026-08-31T04:16:02.000Z",
    "resumed": false,
    "documents": [
      {
        "id": "30000000-0000-4000-8000-000000000001",
        "type": "PASSPORT",
        "fileName": "passport.pdf",
        "expiresAt": "2026-09-01T04:15:02.000Z",
        "upload": {
          "mode": "s3-presigned",
          "endpoint": "https://<signed-s3-url>",
          "method": "PUT",
          "headers": { "content-type": "application/pdf" },
          "expiresInSeconds": 900
        }
      },
      {
        "id": "30000000-0000-4000-8000-000000000002",
        "type": "TICKET",
        "fileName": "ticket.jpg",
        "expiresAt": "2026-09-01T04:15:02.000Z",
        "upload": {
          "mode": "s3-presigned",
          "endpoint": "https://<signed-s3-url>",
          "method": "PUT",
          "headers": { "content-type": "image/jpeg" },
          "expiresInSeconds": 900
        }
      }
    ]
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:02.000Z" }
}
```

**Carry forward:** keep `verificationId` for §6.3/§7.1; keep every `documents[].id` for confirmation; perform the direct upload using each `documents[].upload` object. `endpoint` is sensitive and expires after `expiresInSeconds`; do not log it.

**Relevant failures:** `400 VALIDATION_ERROR` for invalid fields. A still-valid request with the same external order returns a resumed session (`resumed: true`) rather than a second active verification.

### 6.2 Upload the actual files

This is a direct object-storage upload, not a Visa Compass API endpoint and it does not return the API envelope.

**Request:**

```http
PUT <documents[].upload.endpoint>
content-type: <documents[].upload.headers.content-type>

<raw file bytes>
```

**Expected response:** the signed storage service returns an HTTP `2xx` response, usually `200` or `204`, with no partner API JSON body.

**Carry forward:** after each successful upload, call §6.3 with that document's `id`. Do not treat a storage `2xx` as final acceptance—the confirmation endpoint validates it.

### 6.3 Confirm each document upload

**Scope:** `documents:write`  
**Request:**

```http
POST /api/v1/partners/document-verifications/20000000-0000-4000-8000-000000000001/documents/30000000-0000-4000-8000-000000000001/confirm
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-passport-confirm-v1
```

There is no body.

**200 response when other documents remain:**

```json
{
  "data": {
    "id": "30000000-0000-4000-8000-000000000001",
    "uploadVerified": true,
    "verificationQueued": false,
    "remaining": 1
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:10.000Z" }
}
```

**200 response after final document:**

```json
{
  "data": {
    "id": "30000000-0000-4000-8000-000000000002",
    "uploadVerified": true,
    "verificationQueued": true,
    "remaining": 0
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:15.000Z" }
}
```

**Relevant failures:**

| HTTP | Code | Message | Action |
| --- | --- | --- | --- |
| 400 | `PARTNER_DOCUMENT_INVALID` | File-validation message | Correct the source file, upload it again, then confirm. |
| 422 | `UPLOAD_DECLARATION_MISMATCH` | `Uploaded bytes do not match the declared size or content type` | Upload the originally declared file, or create a new session with accurate file metadata. |
| 404 | `DOCUMENT_VERIFICATION_NOT_FOUND` | `Document verification not found` | Check the stored verification ID. |
| 404 | `PARTNER_DOCUMENT_NOT_FOUND` | `Document not found` | Use exactly the document ID returned by §6.1. |

### 6.3a Verification controls

Partner documents receive the same server-side passport verification used by the customer and hosted-checkout flows. The server does not trust the upload declaration alone:

- The signed-upload object is checked on confirmation. The service validates the stored object, its actual byte count, and that the detected file format matches the declared PDF, JPEG, or PNG content type.
- For `AUTO_OCR` review, Visa Compass downloads and OCRs the passport, parses its machine-readable zone (MRZ) when present, and validates the MRZ passport-number check digit. It then compares the passport with the traveler information submitted in §6.1. A passport is `VERIFIED` only when its number matches and at least one additional identity field matches: surname, given names, date of birth, or passport expiry date. The verifier uses normalized OCR as a fallback when an MRZ is absent or cannot be parsed; an MRZ is not the only accepted passport layout.
- A partial match or an OCR technical failure is routed to manual review; a failed identity match requires a document replacement. A ticket is required and its upload is verified, but it is not subject to passport identity-field matching.
- The configured `reviewPolicy` is authoritative. `MANUAL_REVIEW` requires an operational decision; `NO_REVIEW` marks documents as skipped. A partner must never infer approval from upload success, `orderCreationAllowed`, or a storage `2xx`.

Only `fulfillmentAllowed=true` permits §7.1a finalization and provisioning.

### 6.4 Check verification status

**Scope:** `documents:write`  
**Request:**

```http
GET /api/v1/partners/document-verifications/20000000-0000-4000-8000-000000000001
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response when order creation is allowed:**

```json
{
  "data": {
    "id": "20000000-0000-4000-8000-000000000001",
    "externalOrderId": "agency-order-1042",
    "status": "VERIFIED",
    "failureCode": null,
    "expiresAt": "2026-09-01T04:15:02.000Z",
    "consumedAt": null,
    "orderCreationAllowed": true,
    "documents": [
      { "id": "30000000-0000-4000-8000-000000000001", "type": "PASSPORT", "uploadVerified": true, "status": "VERIFIED", "code": null, "replacementEligible": false, "verifiedAt": "2026-08-31T04:15:15.000Z" },
      { "id": "30000000-0000-4000-8000-000000000002", "type": "TICKET", "uploadVerified": true, "status": "VERIFIED", "code": null, "replacementEligible": false, "verifiedAt": "2026-08-31T04:15:15.000Z" }
    ]
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:16.000Z" }
}
```

**Carry forward:** only send this response's `id` as `documentVerificationId` in §7.1 when `orderCreationAllowed` is `true`. This permits creation of the pending order; it does **not** permit provisioning. Its `externalOrderId` must equal the order request's `externalOrderId`. After order creation, use `fulfillmentAllowed` as the authoritative permission to call §7.1a.

The implementation also returns `reviewPolicy`, `linkedOrderId`, `requiredDocuments`, `draftCreationAllowed` (the same boolean as `orderCreationAllowed`), and `fulfillmentAllowed`. Each `documents[]` item includes `replacementEligible` (boolean): it is `true` only when that required document has been explicitly requested for replacement on the linked pending order. `fulfillmentAllowed` becomes true only when the created order's required documents have passed the configured review policy.

| Status | Meaning | Partner action |
| --- | --- | --- |
| `AWAITING_UPLOAD` | At least one document not confirmed. | Upload/confirm it. |
| `PROCESSING` | Verification running. | Follow `orderCreationAllowed`: it can be true once every required upload is confirmed, even while review continues. |
| `PROCESSING_BACKGROUND`, `VERIFIED`, `MANUAL_REVIEW`, `SKIPPED` | Required uploads have been received; review may still be running. | Create the pending order only when `orderCreationAllowed=true`; wait for `fulfillmentAllowed=true` before finalizing it. |
| `INVALID` | Documents were rejected or require replacement. | If a pending order exists and the document has `replacementEligible=true`, use §7.1b; otherwise start a new session. |
| `EXPIRED` | Verification expired. | Start a new session. |
| `CONSUMED` | Verification already used. | Find the existing order by external order ID. |

## 7. Create orders

### 7.1 Initial purchase

**Scope:** `orders:write`  
**Request:**

```http
POST /api/v1/partners/orders
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-create-v1
Content-Type: application/json

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

**Field rules:**

| Field | Required | Rules / source |
| --- | --- | --- |
| `externalOrderId` | Yes | Same value used in §6.1; 1-120 characters and unique per partner. |
| `externalCustomerId` | Yes | Your stable customer ID; 1-120 characters. Use the same value for that customer's future top-ups. |
| `planId` | Yes | ID from §5.2. |
| `settlement.method` | No | Omit or set exactly `PARTNER_ACCOUNT`. Other settlement is not supported. |
| `documentVerificationId` | Yes | Verification `id` from §6.4, with `orderCreationAllowed=true`. |
| `consent.*Accepted` | Yes | All three must be literal `true`. |
| `consent.acceptedAt` | Yes | ISO datetime when the traveler accepted. |
| `metadata` | No | String-to-string partner reference data; each value max 500 characters. |

**201 response:**

```json
{
  "data": {
    "id": "40000000-0000-4000-8000-000000000001",
    "orderNumber": "VC-2026-40000000",
    "externalOrderId": "agency-order-1042",
    "status": "REVIEW_PENDING",
    "settlementMethod": "PARTNER_ACCOUNT",
    "metadata": { "branch": "KTM-01" },
    "currency": "NPR",
    "totalAmountPaisa": 250000,
    "plan": { "id": "10000000-0000-4000-8000-000000000001", "countryCode": "JP", "name": "Japan 10 GB / 30 days", "dataAllowance": "10 GB", "validityDays": 30 },
    "travelerComplete": true,
    "documents": [
      { "id": "50000000-0000-4000-8000-000000000001", "type": "PASSPORT", "status": "APPROVED", "passportVerificationStatus": "VERIFIED" },
      { "id": "50000000-0000-4000-8000-000000000002", "type": "TICKET", "status": "APPROVED", "passportVerificationStatus": null }
    ],
    "refund": null,
    "timeline": [{ "from": null, "to": "REVIEW_PENDING", "reason": null, "at": "2026-08-31T04:15:20.000Z" }],
    "fulfillmentStatus": "NOT_READY",
    "documentReviewPolicy": "AUTO_OCR",
    "documentReviewStatus": "VERIFIED",
    "requiredDocuments": ["PASSPORT", "TICKET"],
    "fulfillmentAllowed": true,
    "links": {
      "order": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001",
      "events": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/events",
      "esim": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/esim"
    },
    "esimDetailsAvailable": false,
    "createdAt": "2026-08-31T04:15:20.000Z",
    "updatedAt": "2026-08-31T04:15:21.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:21.000Z" }
}
```

**Carry forward:** persist `data.id` as Visa Compass `orderId`; use it for all order endpoints. Persist `data.externalOrderId` for reconciliation. An initial purchase normally returns `REVIEW_PENDING`; poll the order or its verification. Call §7.1a only when `fulfillmentAllowed=true`. Do not create a second order while a pending, approved, or provisioning order already exists.

**Relevant failures:**

| HTTP | Code | Message | Action |
| --- | --- | --- | --- |
| 400 | `PLAN_UNAVAILABLE` | `Plan is unavailable` | Refresh plans; choose another plan. |
| 400 | `DOCUMENT_VERIFICATION_REQUIRED` | `Document verification is required for an initial purchase` | Complete §6. |
| 400 | `VERIFICATION_ORDER_MISMATCH` | `Document verification does not match this order` | Use verification for this external order only. |
| 400 | `DOCUMENT_REQUIRED` | `Missing required documents: ...` | Supply the named document type. |
| 400 | `INSUFFICIENT_PARTNER_BALANCE` | `Partner prepaid balance is insufficient` | Top up partner account; then submit a new request. |
| 409 | `VERIFICATION_NOT_READY` | `Document verification is not complete` | Poll §6.4. |
| 409 | `DOCUMENT_UPLOAD_NOT_CONFIRMED` | `Confirm every required document upload before placing the order` | Confirm all files. |
| 409 | `EXTERNAL_ORDER_ID_EXISTS` | `External order ID already exists` | Call §8.3 by external order ID; do not duplicate the sale. |
| 409 | `VERIFICATION_ALREADY_CONSUMED` | `Document verification was already consumed` | Find the existing order. |
| 410 | `VERIFICATION_EXPIRED` | `Document verification has expired` | Restart §6.1. |
| 422 | `DOCUMENT_REUPLOAD_REQUIRED` | `Documents are invalid; upload replacements` | Re-upload corrected documents. |

### 7.1a Finalize a verified initial purchase

**Scope:** `orders:write`  
**Request:**

```http
POST /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/finalize
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-finalize-v1
```

There is no request body. This endpoint performs the final partner-account debit, changes the order to `APPROVED`, and starts provisioning. It is safe to call again after success: for an already `APPROVED`, provisioning, ready, attention, or completed order it returns the current order with **200**. Call it only when the order response's `fulfillmentAllowed` is `true`. Relevant failures are `404 PARTNER_ORDER_NOT_FOUND`, `409 VERIFICATION_NOT_READY`, `422 DOCUMENT_REUPLOAD_REQUIRED`, `409 PLAN_UNAVAILABLE`, `409 ORDER_CONFLICT`, `400 INSUFFICIENT_PARTNER_BALANCE`, and `409 ESIM_INVENTORY_UNAVAILABLE` / `No eSIM inventory is currently available`. For inventory exhaustion, do not retry immediately; refresh availability later or choose another plan.

### 7.1b Replace a document requested during review

Use this only for an initial-purchase order in `REVIEW_PENDING` or `AWAITING_CUSTOMER` when the verification response marks a required document `replacementEligible=true`.

**Scope:** `documents:write`  
**Request:**

```http
POST /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/document-replacements
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-passport-replacement-v1
Content-Type: application/json

{ "type": "PASSPORT", "fileName": "passport-corrected.pdf", "contentType": "application/pdf", "sizeBytes": 483120 }
```

Only `PASSPORT` and `TICKET` may be replaced. The response returns `verificationId`, `orderId`, `documentId`, `expiresAt`, and a short-lived `upload` object with the same direct-upload contract as §6.2. Upload the bytes, then confirm them with:

```http
POST /api/v1/partners/orders/{orderId}/document-replacements/{documentId}/confirm
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: <new-unique-key>
```

Poll the verification/order again, then finalize only once `fulfillmentAllowed=true`. Relevant failures include `400 DOCUMENT_REPLACEMENT_NOT_ALLOWED`, `409 DOCUMENT_REPLACEMENT_NOT_REQUESTED`, `409 PARTNER_ORDER_INVALID_STATE`, and `410 VERIFICATION_EXPIRED`.

### 7.2 Top-up purchase

**Scope:** `orders:write`  
**Request:**

```http
POST /api/v1/partners/orders
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-topup-2043-create-v1
Content-Type: application/json

{
  "externalOrderId": "agency-topup-2043",
  "externalCustomerId": "customer-91",
  "planId": "10000000-0000-4000-8000-000000000002",
  "purchaseType": "TOPUP",
  "topUpMobile": "+33612345678",
  "consent": {
    "compatibilityAccepted": true,
    "termsAccepted": true,
    "privacyAccepted": true,
    "acceptedAt": "2026-08-31T04:30:00.000Z"
  }
}
```

**Do not send** `documentVerificationId`. `topUpMobile` is required for this flow and must contain the provider-assigned MSISDN of the existing eSIM; it is not the traveller's contact number. The v1 field name is retained for compatibility. `purchaseType: "TOPUP"` is accepted and recommended for clarity, but is optional. `externalCustomerId` must be the same partner customer ID used when the original eSIM was bought.

**201 response:**

```json
{
  "data": {
    "id": "40000000-0000-4000-8000-000000000002",
    "orderNumber": "VC-2026-40000000",
    "externalOrderId": "agency-topup-2043",
    "status": "PROVISIONING",
    "settlementMethod": "PARTNER_ACCOUNT",
    "metadata": null,
    "currency": "NPR",
    "totalAmountPaisa": 250000,
    "plan": { "id": "10000000-0000-4000-8000-000000000002", "countryCode": "JP", "name": "Japan 10 GB / 30 days", "dataAllowance": "10 GB", "validityDays": 30 },
    "travelerComplete": false,
    "documents": [],
    "refund": null,
    "timeline": [{ "from": null, "to": "APPROVED", "reason": null, "at": "2026-08-31T04:30:01.000Z" }],
    "fulfillmentStatus": "PENDING",
    "links": { "order": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000002", "events": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000002/events", "esim": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000002/esim" },
    "esimDetailsAvailable": false,
    "createdAt": "2026-08-31T04:30:01.000Z",
    "updatedAt": "2026-08-31T04:30:01.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:30:01.000Z" }
}
```

**Relevant failures:**

| HTTP | Code | Message | Action |
| --- | --- | --- | --- |
| 422 | `TOPUP_NOT_ELIGIBLE` | For example: `This eSIM cannot subscribe to the selected plan.` | Do not force top-up; obtain consent and use a documented initial purchase if appropriate. |
| 422 | `TOPUP_CUSTOMER_MISMATCH` | `This eSIM is not attached to the supplied partner customer. Use the same externalCustomerId as the original purchase.` | Correct `externalCustomerId`; never attach another customer's eSIM. |
| 409 | `EXTERNAL_ORDER_ID_EXISTS` | `External order ID already exists` | Read the existing order. |

## 8. Read and reconcile orders

### 8.1 List orders

**Scope:** `orders:read`  
**Request:**

```http
GET /api/v1/partners/orders?status=QR_READY&limit=25
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

Query fields: `cursor` (opaque cursor from prior response), `status` (order status), `externalOrderId`, and `limit` (1-100; default 25).

**200 response:**

```json
{
  "data": {
    "items": [
      {
        "id": "40000000-0000-4000-8000-000000000001",
        "orderNumber": "VC-2026-40000000",
        "externalOrderId": "agency-order-1042",
        "status": "QR_READY",
        "settlementMethod": "PARTNER_ACCOUNT",
        "metadata": { "branch": "KTM-01" },
        "currency": "NPR",
        "totalAmountPaisa": 250000,
        "plan": { "id": "10000000-0000-4000-8000-000000000001", "countryCode": "JP", "name": "Japan 10 GB / 30 days", "dataAllowance": "10 GB", "validityDays": 30 },
        "travelerComplete": true,
        "documents": [
          { "id": "50000000-0000-4000-8000-000000000001", "type": "PASSPORT", "status": "APPROVED", "passportVerificationStatus": "VERIFIED" },
          { "id": "50000000-0000-4000-8000-000000000002", "type": "TICKET", "status": "APPROVED", "passportVerificationStatus": null }
        ],
        "refund": null,
        "timeline": [],
        "fulfillmentStatus": "READY",
        "links": { "order": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001", "events": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/events", "esim": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/esim" },
        "esimDetailsAvailable": true,
        "createdAt": "2026-08-31T04:15:20.000Z",
        "updatedAt": "2026-08-31T04:16:10.000Z"
      }
    ],
    "nextCursor": null
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:16:15.000Z" }
}
```

Use `nextCursor` as the next request's `cursor`. Use each item `id` for §8.2, §8.4, §8.5, §9, and §10. The `documents` array contains the same document summaries returned by the order endpoints; it never contains upload URLs or file contents. List results never contain activation secrets.

### 8.2 Get order by Visa Compass ID

**Scope:** `orders:read`  
**Request:**

```http
GET /api/v1/partners/orders/40000000-0000-4000-8000-000000000001
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response:**

```json
{
  "data": {
    "id": "40000000-0000-4000-8000-000000000001",
    "orderNumber": "VC-2026-40000000",
    "externalOrderId": "agency-order-1042",
    "status": "QR_READY",
    "settlementMethod": "PARTNER_ACCOUNT",
    "metadata": { "branch": "KTM-01" },
    "currency": "NPR",
    "totalAmountPaisa": 250000,
    "plan": { "id": "10000000-0000-4000-8000-000000000001", "countryCode": "JP", "name": "Japan 10 GB / 30 days", "dataAllowance": "10 GB", "validityDays": 30 },
    "travelerComplete": true,
    "documents": [
      { "id": "50000000-0000-4000-8000-000000000001", "type": "PASSPORT", "status": "APPROVED", "passportVerificationStatus": "VERIFIED" },
      { "id": "50000000-0000-4000-8000-000000000002", "type": "TICKET", "status": "APPROVED", "passportVerificationStatus": null }
    ],
    "refund": null,
    "timeline": [],
    "fulfillmentStatus": "READY",
    "links": { "order": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001", "events": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/events", "esim": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/esim" },
    "esimDetailsAvailable": true,
    "createdAt": "2026-08-31T04:15:20.000Z",
    "updatedAt": "2026-08-31T04:16:10.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:16:16.000Z" }
}
```

**Relevant failure:** `404 PARTNER_ORDER_NOT_FOUND` / `Order not found` — check the ID and partner credential.

### 8.3 Get order by your external ID

**Scope:** `orders:read`  
**Request:**

```http
GET /api/v1/partners/orders/by-external-id/agency-order-1042
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response:**

```json
{
  "data": {
    "id": "40000000-0000-4000-8000-000000000001",
    "orderNumber": "VC-2026-40000000",
    "externalOrderId": "agency-order-1042",
    "status": "QR_READY",
    "settlementMethod": "PARTNER_ACCOUNT",
    "metadata": { "branch": "KTM-01" },
    "currency": "NPR",
    "totalAmountPaisa": 250000,
    "plan": { "id": "10000000-0000-4000-8000-000000000001", "countryCode": "JP", "name": "Japan 10 GB / 30 days", "dataAllowance": "10 GB", "validityDays": 30 },
    "travelerComplete": true,
    "documents": [
      { "id": "50000000-0000-4000-8000-000000000001", "type": "PASSPORT", "status": "APPROVED", "passportVerificationStatus": "VERIFIED" },
      { "id": "50000000-0000-4000-8000-000000000002", "type": "TICKET", "status": "APPROVED", "passportVerificationStatus": null }
    ],
    "refund": null,
    "timeline": [],
    "fulfillmentStatus": "READY",
    "links": { "order": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001", "events": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/events", "esim": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/esim" },
    "esimDetailsAvailable": true,
    "createdAt": "2026-08-31T04:15:20.000Z",
    "updatedAt": "2026-08-31T04:16:10.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:16:16.000Z" }
}
```

**Use this endpoint** after `409 EXTERNAL_ORDER_ID_EXISTS` or an unknown create-order result.  
**Relevant failure:** `404 PARTNER_ORDER_NOT_FOUND` / `Order not found`.

### 8.4 Get eSIM activation details

**Scope:** `esims:read`  
**Request:**

```http
GET /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/esim
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response:**

```json
{
  "data": {
    "orderId": "40000000-0000-4000-8000-000000000001",
    "externalOrderId": "agency-order-1042",
    "status": "QR_READY",
    "fulfillmentStatus": "READY",
    "documentStatus": "VERIFIED",
    "recoverability": null,
    "iccid": "8988212345678901234",
    "msisdn": "+819012345678",
    "smDpAddress": "smdp.example.provider",
    "activationCode": "LPA:1$smdp.example.provider$ACTIVATION-CODE",
    "activatedAt": null,
    "expiresAt": "2026-09-30T04:15:30.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:15:31.000Z" }
}
```

`activationCode`, `iccid`, and `msisdn` are sensitive. Deliver them only to the intended traveler; do not log or include them in analytics.

| HTTP | Code | Message | Action |
| --- | --- | --- | --- |
| 404 | `PARTNER_ORDER_NOT_FOUND` | `Order not found` | Check order ID. |
| 409 | `PARTNER_ORDER_NOT_READY` | `Activation details are available once the eSIM is ready to use` | Poll order until `QR_READY`, `ACTIVATION_ATTENTION`, or `COMPLETED`. |
| 404 | `PARTNER_ACTIVATION_UNAVAILABLE` | `Activation details are not available yet` | Retry GET with backoff; contact support if persistent. |

### 8.5 Get events

**Scope:** `orders:read`  
**Request:**

```http
GET /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/events
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response:**

```json
{
  "data": [
    {
      "id": "70000000-0000-4000-8000-000000000001",
      "type": "order.accepted",
      "version": 0,
      "resourceId": "40000000-0000-4000-8000-000000000001",
      "correlationId": "<correlation-id>",
      "payload": { "orderId": "40000000-0000-4000-8000-000000000001", "externalOrderId": "agency-order-1042", "status": "REVIEW_PENDING", "fulfillmentStatus": "NOT_READY", "version": 0, "amountPaisa": 250000, "currency": "NPR" },
      "occurredAt": "2026-08-31T04:15:20.000Z"
    }
  ],
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:16:20.000Z" }
}
```

Use events for audit/reconciliation; treat the current order endpoint as authoritative.

### 8.6 Get usage

**Scope:** `usage:read`  
**Request:**

```http
GET /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/usage
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response:**

```json
{
  "data": {
    "usedMb": 1024,
    "totalMb": 10240,
    "usageAvailable": true,
    "subscriptions": [
      { "providerSubscriptionId": "provider-subscription-1", "status": "active", "usedMb": 1024, "totalMb": 10240, "priority": 1 }
    ]
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:17:00.000Z" }
}
```

**Relevant failures:** `404 PARTNER_ORDER_NOT_FOUND` / `Order not found`; `400 PARTNER_USAGE_UNAVAILABLE` / `Usage details are available once the eSIM is active`. Wait for `COMPLETED` before retrying usage.

### 8.7 Get account

**Scope:** `orders:read`  
**Request:**

```http
GET /api/v1/partners/account
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

**200 response:**

```json
{
  "data": {
    "currency": "NPR",
    "balancePaisa": 9750000,
    "availableBalancePaisa": 9750000,
    "totalDebitsPaisa": 250000,
    "totalCreditsPaisa": 10000000,
    "totalRefundedPaisa": 0,
    "totalAdjustedPaisa": 0,
    "ordersCreated": 1,
    "ordersByStatus": { "QR_READY": 1 },
    "fulfilledOrders": 1,
    "failedOrders": 0,
    "totalOrderValuePaisa": 250000,
    "averageOrderValuePaisa": 250000,
    "updatedAt": "2026-08-31T04:15:21.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:16:00.000Z" }
}
```

Use `balancePaisa` before creating sales. It is an informative read, not a reservation; the order endpoint performs the final debit check.

### 8.8 Get ledger

**Scope:** `orders:read`  
**Request:**

```http
GET /api/v1/partners/ledger?externalOrderId=agency-order-1042&limit=25
Authorization: Bearer vc_partner_<key-prefix>.<secret>
```

Optional query fields: `cursor`, `from`/`to` ISO datetimes, `externalOrderId`, `orderNumber`, `reference`, `type` (`CREDIT`, `DEBIT`, `REFUND`, `ADJUSTMENT`), and `limit` 1-100.

**200 response:**

```json
{
  "data": {
    "items": [
      {
        "id": "60000000-0000-4000-8000-000000000001",
        "type": "DEBIT",
        "amountPaisa": 250000,
        "balanceAfterPaisa": 9750000,
        "currency": "NPR",
        "reference": "debit:<partner-id>:agency-order-1042",
        "order": { "id": "40000000-0000-4000-8000-000000000001", "externalOrderId": "agency-order-1042", "orderNumber": "VC-2026-40000000" },
        "createdAt": "2026-08-31T04:15:20.000Z"
      }
    ],
    "nextCursor": null
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:16:01.000Z" }
}
```

Use `nextCursor` for pagination. Use `DEBIT`/`REFUND` entries to reconcile order settlement.

## 9. Mutate an existing order

### 9.1 Cancel an eligible order

**Scope:** `orders:write`  
**Request:**

```http
POST /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/cancel
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-cancel-v1
Content-Type: application/json

{ "reason": "Customer cancelled before provisioning" }
```

`reason` is required, trimmed, and 3-1000 characters. Cancellation is permitted only in `DRAFT`, `PAYMENT_PENDING`, `AWAITING_CUSTOMER`, or `REVIEW_PENDING`.

**200 response:**

```json
{
  "data": {
    "id": "40000000-0000-4000-8000-000000000001",
    "orderNumber": "VC-2026-40000000",
    "externalOrderId": "agency-order-1042",
    "status": "CANCELLED",
    "settlementMethod": "PARTNER_ACCOUNT",
    "metadata": { "branch": "KTM-01" },
    "currency": "NPR",
    "totalAmountPaisa": 250000,
    "plan": { "id": "10000000-0000-4000-8000-000000000001", "countryCode": "JP", "name": "Japan 10 GB / 30 days", "dataAllowance": "10 GB", "validityDays": 30 },
    "travelerComplete": true,
    "documents": [],
    "refund": null,
    "timeline": [{ "from": "REVIEW_PENDING", "to": "CANCELLED", "reason": "Customer cancelled before provisioning", "at": "2026-08-31T04:17:10.000Z" }],
    "fulfillmentStatus": "NOT_READY",
    "links": { "order": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001", "events": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/events", "esim": "/api/v1/partners/orders/40000000-0000-4000-8000-000000000001/esim" },
    "esimDetailsAvailable": false,
    "createdAt": "2026-08-31T04:15:20.000Z",
    "updatedAt": "2026-08-31T04:17:10.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:17:10.000Z" }
}
```

**Relevant failures:** `404 PARTNER_ORDER_NOT_FOUND`; `400 PARTNER_ORDER_INVALID_STATE` / `Order cannot be changed in its current state`; `409 ORDER_CONFLICT` / `Order was changed by another request; reload and retry`. On `409`, GET the order before another mutation.

### 9.2 Request a refund

**Scope:** `refunds:write`  
**Request:**

```http
POST /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/refund-requests
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-refund-v1
Content-Type: application/json

{ "reason": "Provisioning was unsuccessful" }
```

**201 response:**

```json
{
  "data": {
    "id": "80000000-0000-4000-8000-000000000001",
    "partnerId": "<partner-id>",
    "orderId": "40000000-0000-4000-8000-000000000001",
    "amountPaisa": 250000,
    "reason": "Provisioning was unsuccessful",
    "status": "REQUESTED",
    "decidedById": null,
    "decidedAt": null,
    "createdAt": "2026-08-31T04:17:20.000Z",
    "updatedAt": "2026-08-31T04:17:20.000Z"
  },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:17:20.000Z" }
}
```

This is a request, not an immediate refund. `status: REQUESTED` means it has entered review; observe subsequent order status, events, webhook, and ledger entries.

**Relevant failures:** `404 PARTNER_ORDER_NOT_FOUND`; `400 PARTNER_ORDER_INVALID_STATE`; `409 ORDER_CONFLICT`.

### 9.3 Queue a traveler notification

**Scope:** `orders:write`  
**Request:**

```http
POST /api/v1/partners/orders/40000000-0000-4000-8000-000000000001/notifications
Authorization: Bearer vc_partner_<key-prefix>.<secret>
Idempotency-Key: agency-order-1042-qr-notification-v1
Content-Type: application/json

{ "channel": "EMAIL", "template": "QR_READY" }
```

`channel` is `EMAIL` or `WHATSAPP`. `template` is `ORDER_STATUS`, `QR_READY`, or `DOCUMENT_REUPLOAD`. The recipient is the stored traveler contact; an arbitrary recipient cannot be supplied.

**201 response:**

```json
{
  "data": { "id": "90000000-0000-4000-8000-000000000001", "status": "QUEUED" },
  "meta": { "correlationId": "<correlation-id>", "timestamp": "2026-08-31T04:17:30.000Z" }
}
```

`QUEUED` confirms the delivery job was accepted; it does not prove that the traveler received or read it.

**Relevant failures:** `404 PARTNER_ORDER_NOT_FOUND`; `400 PARTNER_TRAVELER_REQUIRED` / `Traveller contact details are required`; validation error for unsupported channel/template.

## 10. Order statuses and partner action

| Status | Meaning | Partner action |
| --- | --- | --- |
| `DRAFT` | An order record has been started but is not yet approved for fulfillment. | Complete or cancel it; do not expect a debit or eSIM. |
| `PAYMENT_PENDING` | A payment step is pending. This state is retained for lifecycle compatibility; it is not normally produced for `PARTNER_ACCOUNT` settlement. | Resolve the payment state or cancel; do not provision. |
| `APPROVED` | Order and debit succeeded. | Await provisioning. |
| `REVIEW_PENDING` | Initial-purchase order was created and awaits or has completed document review. | Poll until `fulfillmentAllowed=true`, then call §7.1a. |
| `AWAITING_CUSTOMER` | A required document needs a replacement. | Use §7.1b when the verification marks it eligible. |
| `PROVISIONING` | eSIM provisioning in progress. | Poll/read webhook; do not create another order. |
| `QR_READY` | Activation details can be retrieved. | Call §8.4 and deliver securely. |
| `COMPLETED` | eSIM is active. | Call §8.6 for usage if needed. |
| `ACTIVATION_ATTENTION` | Operational review is needed. | Contact Visa Compass; do not duplicate the order. |
| `PROVISIONING_FAILED` | Fulfillment failed. | Contact Visa Compass or create an eligible refund request. |
| `CANCELLED` | Closed by cancellation. | Reconcile ledger. |
| `REFUND_PENDING` | Refund request awaiting decision. | Await webhook/order/ledger update. |
| `REFUNDED` | Refund completed. | Reconcile `REFUND` ledger entry. |

## 11. Outbound webhooks

Visa Compass configures partner webhook destinations during onboarding. Webhooks are at-least-once and can arrive out of order; use the order API as the final authority.

**Webhook request:**

```http
POST <your-webhook-url>
Content-Type: application/json
User-Agent: VisaCompass-Partner-Webhooks/1.0
VC-Event-Id: <event-id>
VC-Webhook-Timestamp: <unix-seconds>
VC-Webhook-Signature: v1=<hex-hmac>
```

```json
{
  "id": "event-uuid",
  "partnerId": "partner-uuid",
  "type": "order.accepted",
  "version": 0,
  "resourceId": "40000000-0000-4000-8000-000000000001",
  "occurredAt": "2026-08-31T04:15:20.000Z",
  "correlationId": "<correlation-id>",
  "data": { "orderId": "40000000-0000-4000-8000-000000000001", "externalOrderId": "agency-order-1042" }
}
```

**Expected partner response:** return any HTTP `2xx` only after durably recording the event. For example:

```http
HTTP/1.1 204 No Content
```

Verify `VC-Webhook-Signature` using:

```text
HMAC_SHA256(webhook_secret, "<VC-Webhook-Timestamp>.<exact-raw-request-body>")
```

Deduplicate on `VC-Event-Id`, reject stale timestamps under your replay policy, and do not follow webhook payloads with assumptions about event order. Visa Compass does not follow redirects, times out after 10 seconds, and attempts delivery at most three times.

## 12. Partner implementation checklist

- Store the API key and webhook secret only in server-side secret storage.
- Persist idempotency keys, `externalOrderId`, `verificationId`, document IDs, order ID, and correlation IDs.
- Do not log documents, signed upload URLs, activation codes, ICCIDs, or MSISDNs.
- Call order creation only with `orderCreationAllowed: true`.
- After any uncertain POST result, retry the exact request with the same idempotency key or query by `externalOrderId`.
- On `409` state conflicts, GET the resource before performing another mutation.
- On `429`, follow `Retry-After`. On `5xx`, use bounded exponential backoff and contact support with correlation ID if persistent.
