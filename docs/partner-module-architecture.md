# Visa Compass — Partner Module Architecture (internal)

This document explains how the partner integration works _inside our codebase_, based on branch
`API-integratedv1`. It answers three questions:

1. How is it configured on our end (onboarding, our schema, auth, ops tooling)?
2. What is exposed to partners (the remote-facing API, scopes, those capabilities)?
3. What actually happens at each step of the flow?

The partner-facing contract lives in `docs/PartnersApi2.0.md` (public-facing); this file is the
internal/server-side view. Base URL `/api/v1/partners`, Swagger `/api/partner-docs`.

---

## 1. Configuration on our side

### 1.1 Where the code lives

| Concern                                    | File                                                     |
| ------------------------------------------ | -------------------------------------------------------- |
| Public partner routes (`/partners/...`)    | `src/modules/partners/partners.controller.ts`            |
| Public partner business logic              | `src/modules/partners/partner.service.ts` (~1400 lines)  |
| API-key auth / scopes / rate-limit         | `src/modules/partners/partner-auth.guard.ts`             |
| Super Admin routes (`/admin/partners/...`) | `src/modules/partners/partner-admin.controller.ts`       |
| Super Admin business logic                 | `src/modules/partners/partner-admin.service.ts`          |
| Hosted-checkout (token) flow               | `src/modules/partners/partner-checkout.controller.ts`    |
| Outbound signed webhooks                   | `src/jobs/partner-webhook.processor.ts`                  |
| Persistence models                         | `apps/api/prisma/schema.prisma` (models below `Partner`) |

All are wired in `src/app.module.ts`: `PartnersController`, `PartnerAdminController`,
`PartnerCheckoutController` are registered as controllers; `PartnerService`, `PartnerAdminService`,
`PartnerWebhookProcessor`, and `PartnerAuthGuard` as providers.

- Public partner controllers are protected by `@UseGuards(PartnerAuthGuard)`.
- Admin controller is gated `@UseGuards(AuthGuard, AccountGuard)` + `@AccountTypes(SUPER_ADMIN)`.

### 1.2 Onboarding path (Super Admin only)

The operator flow is **create partner → top up balance → issue credential → activate**:

1. **Create partner** `POST /admin/partners` with `code`, `name`, `allowedSettlementMethods`,
   optional `rateLimitPerMinute`, `redirectAllowlist`. The service validates the code
   (`/^[a-z0-9][a-z0-9_-]{3,31}$/`), creates the row in **`PENDING`** status and, in the same
   transaction, a `PartnerAccount` (`balancePaisa`, `creditLimitPaisa`). Every mutation writes an
   `AuditLog` row (`module = "PARTNERS"`).
2. **Top up / adjust** `POST /admin/partners/:id/ledger-adjustments` credits/prepends the prepaid
   balance (this is how a partner gets funds; there is no credit card flow on our side for MVP).
3. **Issue credential** `POST /admin/partners/:id/credentials` returns the fully-formed API key
   exactly once (`vc_partner_<prefix>.<secret>`). Only the prefix and a SHA-256 **hash** of the
   secret are stored — the raw secret is never recoverable.
4. **Activate** `PATCH /admin/partners/:id` → `status: ACTIVE` (from `PENDING`).
   Until ACTIVE, the partner key is rejected by the guard even if it is technically valid.

### 1.3 Credential & account storage (schema)

- `Partner` — code, name, `status`, `allowedSettlementMethods` (JSON), `rateLimitPerMinute`,
  `redirectAllowlist` (JSON).
- `PartnerCredential` — `keyPrefix` (unique), `secretHash`, `scopes` (JSON), `status`
  (`ACTIVE/REVOKED/EXPIRED`), `expiresAt`, `lastUsedAt`, `revokedAt`.
- `PartnerAccount` — prepaid `balancePaisa`, `creditLimitPaisa`, `reservedPaisa`, and a monotonically
  increasing `version` used for optimistic concurrency.
- `PartnerLedgerEntry` — one row per financial event (`CREDIT/DEBIT/RESERVATION/ADJUSTMENT/REFUND`)
  with `amountPaisa`, `balanceAfterPaisa`, unique `reference` (dedupe).
- `PartnerCustomer` — maps a partner's `externalCustomerId` to our internal `Customer`.
- `PartnerDocumentUploadIntent` — a signed upload promise that links `partnerId`+`externalOrderId`
  to a Cloudinary `privateAssetId`, with `expiresAt` and a `consumedAt` (one-time use).
- `PartnerEvent` / `PartnerWebhookDelivery` / `PartnerWebhookEndpoint` — the durable webhook outbox.
- `PartnerIdempotencyRecord` — dedupe for mutations (`partnerId+method+route+key` unique).
- `PartnerRateBucket` — per-minute per-partner request counting for rate limits.

### 1.4 Auth mechanics (`PartnerAuthGuard`, every public request)

1. Extract `Bearer vc_partner_<prefix>.<secret>`; reject if the prefix is malformed.
2. Look up `PartnerCredential` by `keyPrefix` (include partner). Reject if revoked/expired, or if the
   partner is **not** `ACTIVE`/`SUSPENDED`.
3. Re-hash the presented secret and compare with the stored hash using `timingSafeEqual`.
4. Check that the route's required `PartnerScopes(...)` are all present in the credential → else 403.
5. If partner is `SUSPENDED`, non-GET mutations are blocked (403) but reads still work.
6. Increment the per-minute `PartnerRateBucket`; if over limit → 429; always set
   `x-ratelimit-limit` / `x-ratelimit-remaining`.
7. Stamp `lastUsedAt`, attach the `PartnerPrincipal` to the request.

### 1.5 What partners are given

A Bearer API key with **granular scopes** (enforced server-side per route):

- `catalog:read` — plan/capability discovery
- `orders:read` — list/get orders, events, account status
- `orders:write` — create orders, cancel, notify
- `documents:write` — request upload sessions
- `esims:read` — retrieve activation QR after `QR_READY`
- `refunds:write` — submit refund requests
- `usage:read` — live data consumption
- `payments:write` — present but **deprecated/hosted payments disabled** (MVP is prepaid)

Partners also receive: `Idempotency-Key` support on all mutations, `x-ratelimit-*` headers, and the
standard `{data, meta:{correlationId,timestamp}}` response (and consistent error) envelope.
Capabilities advert (`GET /partners/capabilities`) reports `settlementMethods: ["PARTNER_ACCOUNT"]`,
**empty `payments: []`**, `notifications`, and live connectivity health.

---

## 2. End-to-end step-by-step flow

### Step 0 — Discover

`GET /partners/capabilities` and `GET /partners/plans?country=AE` (scope `catalog:read`).
Server returns ACTIVE plans + their `sellingPrice` (public catalogue) and required documents
(`PASSPORT`, `TICKET`). The price used is the **public `Plan.sellingPrice`**, snapshotted later at
order creation so later catalogue edits can't alter an existing order or its ledger debit.

### Step 1 — Request upload sessions

`POST /partners/document-upload-sessions` (scope `documents:write`, requires `Idempotency-Key`).
Body lists `documents[{type,fileName,contentType,sizeBytes}]` for a given `externalOrderId`.
`createUploadSessions` validates that document types are non-duplicate and safe, then creates
`PartnerDocumentUploadIntent` rows and returns one **presigned Cloudinary upload** per document
(`endpoint`, `publicId`, `apiKey`, `signature`, `timestamp`). The intent records the declared size
and format for later verification.

### Step 2 — Partner uploads bytes

The partner POSTs the raw bytes directly to Cloudinary using the presigned signature. The bytes are
not proxied through us, but the intent "remembers" the expected size/content-type.

### Step 3 — Resolve the order (`createCompleteOrder`)

`POST /partners/orders` (scope `orders:write`, `Idempotency-Key`). This is the core of the MVP.

1. **Settlement guard**: if `settlement.method === "HOSTED_PAYMENT"` → `410 HOSTED_PAYMENT_DEPRECATED`
   (hosted payments are disabled; MVP is prepaid-only).
2. **Plan lookup**: only `status:"ACTIVE"`, country active; else 400 `PLAN_UNAVAILABLE`.
3. **Document completeness**: all required document types for the destination country must be present
   (else 400 `DOCUMENT_REQUIRED`).
4. **Upload intents**: each `uploadId` must exist for this partner + `externalOrderId`, be
   **unconsumed** and **unexpired** (400/409 otherwise).
5. **Document verification** (`storage.verifyDocument`): in the real path, the uploaded file's byte
   size and format must match the declared intent (400 `UPLOAD_NOT_VERIFIED`); in the **simulated**
   storage mode this strict check is skipped.
6. **Price snapshot**: `amountPaisa = round(plan.sellingPrice * 100)` and a `pricingSnapshot`
   (`PUBLIC_CATALOGUE`, prices/country/validity, `capturedAt`).
7. **Atomic transaction** (all-or-nothing):
   - Reject if `externalOrderId` already used by this partner (`ConflictException`).
   - **Consume** the upload intents (one-time use) via `updateMany` → only those still unconsumed.
   - **Upsert `PartnerCustomer`** linking `externalCustomerId` to our `Customer`.
   - Create the **`Order`** (`status: APPROVED`, `orderNumber`, `partnerId`,
     `partnerSettlementMethod: PARTNER_ACCOUNT`, snapshotted price, traveler, documents, initial event).
   - Write the three `CustomerConsent` rows (`COMPATIBILITY`, `TERMS`, `PRIVACY`).
   - **`debitAccount`**: guarded, optimistic debit — asserts `balancePaisa >= amountPaisa`
     (400 `INSUFFICIENT_PARTNER_BALANCE`), then `updateMany` on
     `{id, version, balancePaisa >= amount}` incrementing `version`; if 0 rows matched → `409`
     (concurrent order already spent); then writes a `DEBIT` ledger entry with a unique `reference`.
   - Emit `order.accepted` partner event.
8. **Post-commit handoff** (`approveToProvisioning`, best-effort, failures logged not fatal):
   - `refreshFromPersistence(orderId)` loads the newly created order into the in-memory order store.
   - `approveToProvisioning(orderId)` (orders.service): because the order is `APPROVED`, it **reserves
     an inventory profile** (ICCID), transitions the order to **`PROVISIONING`**, queues the
     provisioning job, and in non-production without a live queue it **processes locally**.

   So a partner `POST /orders` typically returns immediately with `status: PROVISIONING` and a
   `retryAfterSeconds` hint — never blocking on provisioning.

### Step 4 — Provisioning → `QR_READY` → `COMPLETED`

The (queued or local) provisioning job calls our connectivity provider (`AurigaMockProvider` /
`TransatelProvider`). On success it stores the activation `qrPayload`, moves the order to
**`QR_READY`**, and assigns the profile. **`QR_READY` is the commercial fulfillment milestone** — the
partner may now deliver the eSIM. `COMPLETED` is set only when the provider confirms activation.
Customers/operations can later resend or download the password-protected QR.

### Step 5 — Partner reads result

- `GET /partners/orders`, `GET /partners/orders/:id`, `GET /partners/orders/by-external-id/:id`
  (scope `orders:read`) to poll status.
- `GET /partners/orders/:id/esim` (scope `esims:read`) to retrieve the activation package — only
  allowed once the order is `QR_READY` or `COMPLETED`, and activation secrets are never leaked in
  order lists, ledger rows, webhooks, or logs.
- `GET /partners/orders/:id/usage` (scope `usage:read`) for live consumption.
- `GET /partners/account` / `GET /partners/ledger` (scope `orders:read`) for balances and the
  financial trail.

### Step 6 — Cancellation & refund

- `POST /partners/orders/:id/cancel` (scope `orders:write`, `Idempotency-Key`) cancels an
  un-provisioned order and **credits the original debit exactly once**.
- `POST /partners/orders/:id/refund-requests` (scope `refunds:write`) raises a refund request into
  the operations review queue; an operator approves/rejects it `PATCH /admin/partners/refunds/:id`.
  An approved refund credits the same original debit (via a `REFUND` ledger entry) and moves the order
  to `REFUNDED`.

### Step 7 — Durable webhooks

Every meaningful transition is written as a `PartnerEvent` + `PartnerWebhookDelivery` rows (the
**outbox**). `PartnerWebhookProcessor.deliver` POSTs the event to the registered endpoint signed with
an HMAC header `vc-webhook-signature: v1=<...>` (secret derived from the endpoint's
`secretEncrypted`, timestamp-prefixed). It retries with exponential backoff (up to 3 attempts), and a
30-second reconciliation timer re-enqueues any `PENDING/RETRYING` deliveries whose `nextRetryAt`
passed. This path depends on Redis-backed `QueueService`; **if Redis is absent the worker is
simulated**, so real outbound delivery should be validated once Redis is on.

---

## 3. Design invariants worth knowing

- **Prepaid-only MVP.** `HOSTED_PAYMENT` is rejected (`410`); partners collect customer money offline
  and spend their Visa Compass prepaid balance.
- **Atomic order + debit.** Creating the order and debiting the balance happen in one transaction, so
  retries can never create a second debit (unique ledger `reference` + idempotency records).
- **Optimistic balance guard.** The `version` + `updateMany` pattern prevents two concurrent orders
  from overspending a partner's balance (loser gets `409`, not a negative balance).
- **Exactly-once refunds.** Cancellation and approved refunds credit the same original `DEBIT`
  exactly once; `PROVISIONING_FAILED` stays paid and retryable.
- **Price is a snapshot.** Later catalogue edits never alter an existing order or its debit.
- **Payments standardized to none/KHALTI-only, no ESEWA** in active MVP wiring.
- **No activation secrets in read surfaces/webhooks/logs.** Only the `esims:read` endpoint returns
  the activation package, and only after `QR_READY`.
- **Production requires `REDIS_URL`** so provisioning/notification work cannot silently fall back to
  in-process execution.

_Coverage on `API-integratedv1` @ `ec0e90f`; 116 tests pass (16 files), including
`partner-contract.test.ts` and `partner-prepaid.test.ts`._
