# Visa Compass Partner API 2.0 Specification

Base URL: `/api/v1/partners`  
Swagger UI: `/api/partner-docs`  
OpenAPI JSON: `/api/partner-docs/openapi.json`

---

## 1. System Overview & Core Principles

The Visa Compass Partner API 2.0 provides commercial agencies and resellers with a unified, high-performance interface for discovering eSIM plans, generating secure document upload sessions, placing complete orders with automated provisioning, tracking data usage, and managing accounts.

### Authentication & Authorization

- **Bearer Token Header:** Send `Authorization: Bearer vc_partner_<prefix>.<secret>` on all requests.
- **Granular Scopes:** API credentials enforce fine-grained scope permissions:
  - `catalog:read`: Plan and capability discovery.
  - `orders:read`: Querying orders, timeline events, and account status.
  - `orders:write`: Submitting new orders, notifications, and cancellations.
  - `documents:write`: Requesting presigned document upload sessions.
  - `payments:write`: Deprecated; hosted payments are disabled for the MVP.
  - `esims:read`: Retrieving activation details after an order reaches `QR_READY`.
  - `refunds:write`: Submitting formal refund requests.
  - `usage:read`: Real-time eSIM data consumption queries.

### Reliability & Standards

- **Idempotency:** All mutation requests (`POST`) require an `Idempotency-Key` header (8–200 characters). Duplicate submissions with the same key safely return the cached response.
- **Rate Limiting:** Responses contain `x-ratelimit-limit` and `x-ratelimit-remaining` headers based on partner tier rate limits.
- **Standard Response Envelope:** All successful responses are returned in a standard envelope:
  ```json
  {
    "data": { ... },
    "meta": {
      "correlationId": "b4af1fe9-bf7e-46d7-a155-59339a5b39d9",
      "timestamp": "2026-08-08T22:00:00.000Z"
    }
  }
  ```
- **Error Envelope:**
  ```json
  {
    "data": null,
    "error": {
      "code": "HTTP_400",
      "message": "Document upload could not be verified"
    },
    "meta": {
      "correlationId": "a53ec520-3a87-4dbd-99b5-61899046a544",
      "timestamp": "2026-08-08T22:00:00.000Z"
    }
  }
  ```

---

## 2. End-to-End Primary Order Flow

The primary 2.0 integration flow allows partners to create, verify, and provision an order in 3 steps:

```
[Partner App] --- (1) GET /plans ---> [Visa Compass API] (Get planId & required docs)
[Partner App] --- (2) POST /document-upload-sessions ---> [Visa Compass API] (Get signed upload URLs)
[Partner App] --- (3) Upload bytes ---> [Cloudinary Storage]
[Partner App] --- (4) POST /orders ---> [Visa Compass API] (Auto-verifies, debits balance, provisions eSIM)
```

---

## 3. Detailed Endpoint Reference

### 3.1. Discovery & Catalogue

#### `GET /api/v1/partners/capabilities`

Returns API capabilities, supported settlement methods, enabled payment gateways, and connectivity provider health.

- **Scope:** `catalog:read`
- **Response Example:**
  ```json
  {
    "data": {
      "apiVersion": "v1",
      "currency": "NPR",
      "settlementMethods": ["PARTNER_ACCOUNT"],
      "payments": [],
      "notifications": ["EMAIL", "WHATSAPP"],
      "connectivity": {
        "provider": "AURIGA_MOCK",
        "capabilities": {
          "catalogSync": true,
          "provisioning": true,
          "usage": true
        },
        "health": { "ok": true }
      },
      "idempotencyRequiredForMutations": true
    }
  }
  ```

#### `GET /api/v1/partners/plans`

Retrieves active eSIM destination plans.

- **Scope:** `catalog:read`
- **Query Parameters:** `country` (optional, e.g. `JP`, `AE`, `GB`)
- **Response Example:**
  ```json
  {
    "data": [
      {
        "id": "248d4a2b-8c12-4dfa-9c22-58652a92d372",
        "countryCode": "AE",
        "countryName": "United Arab Emirates",
        "name": "United Arab Emirates Connect",
        "dataAllowance": "5 GB",
        "validityDays": 15,
        "price": { "amountPaisa": 249900, "currency": "NPR" },
        "requiredDocuments": ["PASSPORT", "TICKET"],
        "availability": "AVAILABLE"
      }
    ]
  }
  ```

---

### 3.2. Document Uploads & Order Execution

#### `POST /api/v1/partners/document-upload-sessions`

Requests presigned Cloudinary upload signatures for traveler documents.

- **Scope:** `documents:write`
- **Headers:** `Idempotency-Key: <unique-key>`
- **Request Body:**
  ```json
  {
    "externalOrderId": "flow-agency-order-3001",
    "documents": [
      {
        "type": "PASSPORT",
        "fileName": "passport.pdf",
        "contentType": "application/pdf",
        "sizeBytes": 282
      },
      {
        "type": "TICKET",
        "fileName": "ticket.pdf",
        "contentType": "application/pdf",
        "sizeBytes": 282
      }
    ]
  }
  ```
- **Response Example:**
  ```json
  {
    "data": {
      "externalOrderId": "flow-agency-order-3001",
      "documents": [
        {
          "uploadId": "4c45d42e-a43d-4c96-93ef-6ae961182987",
          "type": "PASSPORT",
          "upload": {
            "endpoint": "https://api.cloudinary.com/v1_1/cfci5l6h/auto/upload",
            "publicId": "passport-doc_13b0e978-e961-4fdd-b3bd-fee6c402a3b5",
            "apiKey": "249735284615998",
            "signature": "08939875da5b8d7786f58129958b47742e712599",
            "timestamp": 1786226794
          }
        }
      ]
    }
  }
  ```

#### `POST /api/v1/partners/orders` _(Complete Order)_

Submits a complete order. The server verifies uploaded document bytes, snapshots the plan's public selling price, atomically debits the partner's prepaid balance, and durably submits provisioning. It returns immediately with the current state (normally `APPROVED` or `PROVISIONING`) and never waits for `QR_READY` or `COMPLETED`. The optional `settlement` field defaults to `{ "method": "PARTNER_ACCOUNT" }`.

- **Scope:** `orders:write`
- **Headers:** `Idempotency-Key: <unique-key>`
- **Request Body:**
  ```json
  {
    "externalOrderId": "flow-agency-order-3001",
    "externalCustomerId": "cust-flow-3001",
    "planId": "248d4a2b-8c12-4dfa-9c22-58652a92d372",
    "settlement": { "method": "PARTNER_ACCOUNT" },
    "traveler": {
      "title": "MR",
      "firstName": "Samir",
      "surname": "Majhi",
      "dateOfBirth": "1995-01-01",
      "nationality": "NP",
      "city": "Kathmandu",
      "countryOfResidence": "NP",
      "email": "samir.majhi@visacompassnepal.com",
      "mobile": "+9779800000000",
      "passportNumber": "PA1234567",
      "passportExpiryDate": "2030-01-01"
    },
    "documents": [
      {
        "type": "PASSPORT",
        "uploadId": "4c45d42e-a43d-4c96-93ef-6ae961182987"
      },
      { "type": "TICKET", "uploadId": "7e72d214-2bd1-496d-a793-3e436ca8e928" }
    ],
    "consent": {
      "compatibilityAccepted": true,
      "termsAccepted": true,
      "privacyAccepted": true,
      "acceptedAt": "2026-08-08T20:00:00.000Z"
    }
  }
  ```
- **Response Example:**
  ```json
  {
    "data": {
      "id": "fe40a630-8154-47ab-866d-52a0e4e94241",
      "orderNumber": "VC-2026-FE40A630",
      "externalOrderId": "flow-agency-order-3001",
      "status": "PROVISIONING",
      "fulfillmentStatus": "PENDING",
      "nextAction": { "type": "WAIT_FOR_PROVISIONING" },
      "retryAfterSeconds": 5,
      "settlementMethod": "PARTNER_ACCOUNT",
      "totalAmountPaisa": 249900,
      "travelerComplete": true,
      "esimDetailsAvailable": true,
      "timeline": [
        { "from": null, "to": "APPROVED", "at": "2026-08-08T22:07:17.517Z" },
        {
          "from": "APPROVED",
          "to": "PROVISIONING",
          "reason": "Partner order auto-approved; inventory 899770100000000007 reserved",
          "at": "2026-08-08T22:07:19.980Z"
        },
        {
          "from": "APPROVED",
          "to": "PROVISIONING",
          "reason": "Partner order auto-approved",
          "at": "2026-08-08T22:07:19.980Z"
        }
      ]
    }
  }
  ```

---

### 3.3. Order Queries & Usage Tracking

#### `GET /api/v1/partners/orders`

Lists orders created by the authenticated partner.

- **Scope:** `orders:read`
- **Query Parameters:** `cursor`, `status` (`APPROVED`, `PROVISIONING`, `QR_READY`, `COMPLETED`, `PROVISIONING_FAILED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED`), `externalOrderId`, `limit` (max 100)

`QR_READY` is the commercial fulfillment milestone: the partner may retrieve and deliver the eSIM. `COMPLETED` means the connectivity provider has confirmed activation.

#### `GET /api/v1/partners/orders/:id/esim`

Returns the protected activation package when the order is `QR_READY` or `COMPLETED`.

- **Scope:** `esims:read`
- Activation secrets are never included in order lists, ledger records, webhook payloads, or logs.

#### `GET /api/v1/partners/orders/by-external-id/:externalOrderId`

Fetches order status by external order reference ID.

- **Scope:** `orders:read`

#### `GET /api/v1/partners/orders/:id`

Fetches order status by Visa Compass internal UUID.

- **Scope:** `orders:read`

#### `GET /api/v1/partners/orders/:id/usage`

Returns real-time data consumption for provisioned active eSIM profiles.

- **Scope:** `usage:read`
- **Response Example:**
  ```json
  {
    "data": {
      "usedMb": 0,
      "totalMb": 5120
    }
  }
  ```

#### `GET /api/v1/partners/orders/:id/events`

Returns audit trail timeline events for an order.

- **Scope:** `orders:read`

---

### 3.4. Account Financials & Reconciliation

#### `GET /api/v1/partners/account`

Returns partner account balance, credit limit, and reserved funds.

- **Scope:** `orders:read`
- **Response Example:**
  ```json
  {
    "data": {
      "currency": "NPR",
      "balancePaisa": -269700,
      "outstandingPaisa": 269700,
      "reservedPaisa": 249900,
      "totalDebitsPaisa": 1019600,
      "totalCreditsPaisa": 249900
    }
  }
  ```

#### `GET /api/v1/partners/ledger`

Lists financial ledger transactions (`CREDIT`, `DEBIT`, `RESERVATION`, `ADJUSTMENT`, `REFUND`).

- **Scope:** `orders:read`

---

### 3.5. Order Management & Refunds

#### `POST /api/v1/partners/orders/:id/cancel`

Cancels an un-provisioned order and refunds account funds.

- **Scope:** `orders:write` | **Header:** `Idempotency-Key: <unique-key>`
- **Request Body:** `{ "reason": "Traveler requested cancellation" }`

#### `POST /api/v1/partners/orders/:id/refund-requests`

Submits a formal refund request to the operations review queue.

- **Scope:** `refunds:write` | **Header:** `Idempotency-Key: <unique-key>`
- **Request Body:** `{ "reason": "Connectivity issue reported" }`

---

## 4. No-Code (Hosted) Checkout for Low-Capacity Partners

Not every reseller can integrate the REST API. For partners without an
engineering team, Visa Compass hosts the checkout for them:
the partner calls **one endpoint** to create a session, then shares a
partner-branded link with the traveller over WhatsApp/email. No API
integration is required on the customer-facing side.

### 4.1. Create a hosted checkout session (portal / partner call)

- **`POST /api/v1/partners/hosted-checkout-sessions`**
- **Scope:** `orders:write` | **Header:** `Idempotency-Key`

Request:

```json
{
  "planId": "248d4a2b-8c12-4dfa-9c22-58652a92d372",
  "externalOrderId": "agency-order-3001",
  "externalCustomerId": "cust-flow-3001"
}
```

Response:

```json
{
  "data": {
    "sessionId": "7cfa0b6f-...",
    "token": "A9x…32-char-base64url…",
    "checkoutUrl": "https://shop.visacompass.com/partner-checkout/A9x…",
    "orderId": "fe40a630-8154-47ab-866d-52a0e4e94241",
    "externalOrderId": "agency-order-3001",
    "expiresAt": "2026-08-08T22:00:00.000Z"
  }
}
```

- Creates a **DRAFT** order settled against the partner's prepaid
  `PARTNER_ACCOUNT` balance and a single-use, 24-hour checkout session.
- The partner shares `checkoutUrl`. The traveller is identified relationally as a
  `PartnerCustomer(partnerId, externalCustomerId)`; no traveller account/login
  is required.

### 4.2. Hosted checkout page (public, token-gated)

The customer-facing page is served by Visa Compass at `checkoutUrl`, branded
with the partner's name/logo:

| Method | Path (`/api/v1/partner-checkout/:token`) | Purpose                                              |
| ------ | ---------------------------------------- | ---------------------------------------------------- |
| `GET`  | `/:token`                                | Loads plan, amount, required docs + partner branding |
| `POST` | `/:token/traveler`                       | Saves traveller details (`travelerSchema`)           |
| `POST` | `/:token/documents`                      | Requests a private Cloudinary upload for a document  |
| `POST` | `/:token/documents/:documentId/confirm`  | Confirms the document was uploaded/verified          |
| `POST` | `/:token/verify-passport`                | Runs the server-side passport OCR check              |
| `POST` | `/:token/complete`                       | Completes the order (requires verified passport)     |

On `complete`, the server verifies the uploaded documents, requires a passport
verification of `VERIFIED` (or `SKIPPED` in the local simulator), atomically
debits the partner's prepaid balance, transitions the order to `APPROVED` /
`PROVISIONING`, and consumes the session. The result flows through the same
provisioning and webhook pipeline as an API-placed order.

> The passport must be verified before `complete`; a mismatch returns
> `PASSPORT_VERIFICATION_REQUIRED` so mismatched travellers cannot slip
> through auto-approved partner orders.

## 5. Deprecated Legacy Routes

The following v1 routes are marked `@deprecated` with `Deprecation: true` headers and will be retired:

- `POST /api/v1/partners/quotes` $\rightarrow$ Use `POST /orders` (Complete Order).
- `POST /api/v1/partners/orders/:id/traveler` $\rightarrow$ Include `traveler` payload in `POST /orders`.
- `POST /api/v1/partners/orders/:id/documents` $\rightarrow$ Use `POST /document-upload-sessions`.
- `POST /api/v1/partners/orders/:id/hosted-checkout-session` and `/payment-session`
  $\rightarrow$ Use `POST /hosted-checkout-sessions` (no-code hosted checkout, section 4).
- Legacy hosted-payment settlements are retired; partners settle via prepaid
  `PARTNER_ACCOUNT` balance.
