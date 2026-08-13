# Visa Compass eSIM Platform — Comprehensive Specification

This document is the single authoritative reference for the Visa Compass eSIM
platform. It describes every application, every form field (type, length,
required/optional, validation), every API endpoint (method, path, guards,
request/response shapes, error codes), the Transatel integration contract
(what we send, what we receive, and exactly what the customer sees in every
case), the full error-code catalog with customer-facing messages, every event
and its trigger/effect, the notification templates (verbatim text), the
background job model, the database schema, and the environment
configuration.

Reference code locations are given as `path:line`. "Customer-safe message"
means the exact string returned in the HTTP response `error.message` or shown
in the customer UI; internal diagnostics never reach clients.

---

## 1. Platform overview

Visa Compass is a TypeScript monorepo that lets travellers buy a travel eSIM,
upload identity documents, pay in NPR via Khalti, and receive an
activation QR by email (as a password-protected PDF) once payment is verified
and a connectivity provider (Transatel) has provisioned the profile. Orders
are approved automatically after a verified payment; the operations review
queue is reserved for exceptions (document replacements, failed activations).

### 1.1 Applications

| Workspace | Technology | Local URL | Purpose |
| --- | --- | --- | --- |
| `apps/api` | NestJS (v10+), Prisma, BullMQ | `http://localhost:4000` | All business logic, integrations, webhooks, jobs |
| `apps/customer-web` | Next.js App Router + Clerk | `http://localhost:3000` | Customer portal: browse, checkout, eSIMs, notifications |
| `apps/ops-web` | Next.js App Router + Clerk | `http://localhost:3001` | Operations + Admin portal: review, inventory, admin |
| `packages/shared` | Internal TS package | — | Enums, zod schemas, API error codes, contracts |

All requests are namespaced under `/api/v1`. Swagger is exposed at
`http://localhost:4000/api/docs` (`apps/api/src/main.ts:24`).

### 1.2 Execution model

- **Bootstrap** (`apps/api/src/main.ts`): `helmet()`, CORS restricted to the
  two web origins with credentials, global prefix `api/v1`, a global
  `ValidationPipe` (`whitelist: true, transform: true`), the global
  `ApiExceptionFilter`, the global `RateLimitGuard`, and three global
  interceptors (Correlation → Logging → Idempotency).
- **Persistence** (`apps/api/src/infrastructure/prisma.service.ts:7`):
  Prisma + CockroachDB is active only when `PERSISTENCE_MODE=prisma` and
  `DATABASE_URL` are set. Otherwise the API runs entirely from an in-memory
  order store (`OrdersService.orders` Map) plus in-memory queue/notification
  simulation — used for local development and tests.
- **Queue** (`apps/api/src/jobs/queue.service.ts`): BullMQ when `REDIS_URL` is
  set; otherwise `add()` returns `{ simulated: true }` and processors are
  invoked in-process by the caller.

---

## 2. Identity, roles, and authorization

Auth is issued by Clerk (customer self-signup public; staff are separate
identities created through Super Admin invitations). The database is
**authoritative** for role assignment — Clerk metadata never grants API
permissions.

### 2.1 Authentication guard (`apps/api/src/common/auth.guard.ts`)

- `AuthGuard` requires `Authorization: Bearer <Clerk session token>` and
  `CLERK_SECRET_KEY`. It verifies the token with `@clerk/backend.verifyToken`
  and enforces `authorizedParties` = exactly `CUSTOMER_WEB_URL` and
  `OPS_WEB_URL` (tokens minted for other origins are rejected).
- On success it calls `clerkSync.ensureUser(sub)` (just-in-time sync), loads
  the local `User`, rejects `DISABLED` users and `BLOCKED` customers
  (`ACCOUNT_DISABLED`, 403), derives roles, and attaches `request.user`.
- Error responses are `HttpException {code, message}`:
  - 401 `AUTHENTICATION_REQUIRED` — missing/invalid token.
  - 401 `ACCOUNT_SYNCHRONIZATION_FAILED` — token valid but no local user.
  - 403 `ACCOUNT_DISABLED` — user disabled or customer blocked.

### 2.2 Roles and capabilities (`auth.guard.ts:18-30`, `admin.service.ts:334`)

| Account type | Effective capabilities |
| --- | --- |
| `CUSTOMER` | `customer:portal`, `customer:orders` |
| `OPERATIONS` | `operations:portal`, `operations:review`, `operations:inventory` |
| `SUPER_ADMIN` | everything above plus `admin:portal`, `admin:users`, `admin:configuration` |

- `AccountGuard` enforces `@AccountTypes(...)` on controllers. `SUPER_ADMIN`
  is allowed on OPERATIONS-only controllers, but never on CUSTOMER
  controllers.
- `requireRole(request, [...])` is used per-route for the Operations/
  Admin surfaces.
- **Super Admin MFA**: enabled by default (`ENFORCE_SUPER_ADMIN_MFA !==
  'false'`). An MFA-verified session is one whose Clerk session `fva` array has
  `fva[1] >= 0` (positive MFA-age seconds). Super Admins without verified MFA
  get 403 `MFA_REQUIRED` on every protected route.

### 2.3 Identity sync (`apps/api/src/modules/identity/clerk-sync.service.ts`)

Handles `user.created` / `user.updated` / `user.deleted` webhooks and
just-in-time sync:

- Email is taken from the primary verified address, lowercased.
- New users: assigned `CUSTOMER` by default; a pending staff invitation
  grants `OPERATIONS`/`SUPER_ADMIN`; the `BOOTSTRAP_SUPER_ADMIN_EMAIL`
  becomes Super Admin **only if no active Super Admin exists**.
- Customers get a `Customer` row with `customerCode` `VC-<userId[:8]>`.
- `user.deleted` → user set to `DISABLED` (soft disable).
- A customer who owns orders/eSIMs can never be silently converted to staff;
  an audit entry `BOOTSTRAP_REQUIRES_SEPARATE_STAFF_IDENTITY` is written.

### 2.4 Staff administration (`apps/api/src/modules/admin/admin.service.ts`)

- Invitations: `Clerk invitations.createInvitation` + `StaffInvitation` row
  (7-day expiry, statuses PENDING/ACCEPTED/REVOKED/EXPIRED). A staff email
  must not already be a customer account. Every invite/resend/revoke is
  audited (`module: IDENTITY`).
- Account type / status changes are audited; the **final active Super Admin
  cannot be demoted or disabled** (`ensureFinalAdmin`).

---

## 3. Database schema (`apps/api/prisma/schema.prisma`)

Provider: `cockroachdb`. All JSON columns are `Json`; all money columns are
`Decimal(12,2)`; UUID PKs are `String @db.Uuid`. Pending migrations (not yet
applied to a real database): `20260804000300_transatel_provider_columns`,
`20260805000100_subscription_usage`, `20260805000200_integration_log`.

### 3.1 Identity & RBAC

| Model | Fields (type · notes) |
| --- | --- |
| `User` | `id` Uuid PK; `clerkId` String unique; `email` String unique; `status` UserStatus default ACTIVE; `accountType` UserRoleName default CUSTOMER; timestamps. Relations: roles, customer?, reviews, auditLogs, staffInvitationsSent |
| `Role` | `id` Uuid PK; `name` UserRoleName unique |
| `UserRole` | composite PK `(userId, roleId)` |
| `StaffInvitation` | `id`; `email` String; `accountType` UserRoleName; `status` default PENDING; `clerkInvitationId` String? unique; `invitedById` Uuid FK; `expiresAt` DateTime; `acceptedAt?`; `revokedAt?`; index `[email, status]` |
| `Customer` | `id`; `userId` Uuid? unique; `customerCode` String unique; `source` CustomerSource default WEBSITE; `email` String unique; `phone?`; `preferredLanguage` default "en"; `status` CustomerStatus default ACTIVE; `deletedAt?`; relations: orders, esims, consents |

### 3.2 Catalog

| Model | Fields |
| --- | --- |
| `Country` | `id`; `isoCode` String unique; `name` String; `active` Boolean default true |
| `Plan` | `id`; `countryId` FK; `providerPlanId` String; `name`; `dataAllowance` String (e.g. "5 GB"/"Unlimited"); `validityDays` Int; `costPrice` Decimal(12,2); `sellingPrice` Decimal(12,2); `currency` default "NPR"; `coverage` Json (array of country names); `popular` default false; `status` PlanStatus default DRAFT; unique `[countryId, providerPlanId]` |

### 3.3 Orders & journey

| Model | Fields |
| --- | --- |
| `Order` | `id`; `orderNumber` unique (`VC-<YYYY>-<8 hex>`); `customerId` FK; `planId` FK; `orderType` default INITIAL_PURCHASE; `status` OrderStatus default DRAFT; `currency` default NPR; `subtotal`/`discount`/`tax`/`totalAmount` Decimal(12,2); `pricingSnapshot` Json; `compatibilityAcceptedAt` DateTime; `providerSubscriptionId?`; `providerStatus?`; `version` Int default 0 (optimistic locking); indexes `[customerId,status]`, `[status,createdAt]` |
| `Traveler` | `orderId` unique FK; `title`, `firstName`, `middleName?`, `surname`; `dateOfBirthEncrypted` (AES-256-GCM); `nationality`; `city`; `countryOfResidence`; `employerOrBusinessName?`; `email`; `mobile`; `passportNumberEncrypted`; `passportNumberHash` unique (HMAC blind index); `passportExpiryEncrypted`; `pointOfSaleCode?`; `countryOfPurchase` default "NP"; `subscriberLanguage` default "en" |
| `TravelerDocument` | `id`; `orderId` FK; `type` DocumentType; `fileName`; `privateAssetId` (Cloudinary `folder/publicId`); `status` default PENDING; `reviewedById?`; `reviewedAt?`; unique `[orderId, type]`; index `[status]` |
| `Payment` | `id`; `orderId` FK; `provider` PaymentProvider; `providerTransactionId?`; `providerCorrelationId?`; `paymentReference` unique; `amount` Decimal(12,2); `currency` default NPR; `status` default INITIATED; `paidAt?`; `expiresAt?`; `returnUrl?`; unique `[provider, providerTransactionId]` |
| `OrderEvent` | `id`; `orderId` FK; `fromStatus?`; `toStatus`; `actorId?`; `reason?`; `metadata?` Json; index `[orderId, createdAt]` |
| `OrderReview` | `id`; `orderId` FK; `reviewerId` FK; `decision` ReviewDecision (APPROVED/REJECTED/REUPLOAD_REQUIRED); `reasons` Json; `comments?`; `reviewedAt` |
| `ProvisioningAttempt` | `id`; `orderId` FK; `provider`; `status` ProvisioningStatus; `correlationId` unique; `attempt` Int; `requestSnapshot` Json; `responseSnapshot?` Json; `errorCode?`; `completedAt?` |

### 3.4 Inventory & connectivity

| Model | Fields |
| --- | --- |
| `InventoryBatch` | `id`; `batchReference` unique; `totalProfiles`; `importedCount` default 0; `failedCount` default 0 |
| `EsimInventory` | `id`; `batchId` FK; `iccid` unique; `eid` unique; `status` default IMPORTED; `assignedOrderId?` unique FK; `activationCodeEncrypted?`; `smDpAddress?`; `providerSubscriptionId?`; `providerStatus?`; `activatedAt?`; `expiresAt?`; `version`; index `[status]` |
| `CustomerEsim` | `id`; `customerId` FK; `inventoryId` unique FK; `orderId` unique FK; `qrPayloadEncrypted`; `assignedAt` |
| `Subscription` | `id`; `customerEsimId` FK; `provider`; `providerSubscriptionId` unique; `status` default PENDING; `activatedAt?`; `expiresAt?`; `usedMb` Int default 0; `totalMb` Int default 0; `usageLastCheckedAt?` |

### 3.5 Governance & observability

| Model | Fields |
| --- | --- |
| `WebhookEvent` | `id`; `source` (e.g. `clerk`, `payments:khalti`, `connectivity:transatel`, `idempotency:<...>`); `eventId`; `payload` Json; `signatureValid` Boolean; `processedAt?`; `errorMessage?`; unique `[source, eventId]` |
| `IntegrationLog` | `id`; `operation` (token/provision/usage/esim-details/catalog/eligibility/webhook); `method`; `endpoint` (path+query); `status` Int; `durationMs` Int?; `errorCode?`; `errorMessage?`; `correlationId?`; indexes `[operation, createdAt]`, `[status]` |
| `Notification` | `id`; `orderId?` FK; `channel` String; `template` String; `status` String (QUEUED/SENDING/SENT/SIMULATED/FAILED); `sentAt?` |
| `CustomerConsent` | `id`; `customerId` FK; `type` String; `version` String; `ipAddress` String; `userAgent` String; `acceptedAt` |
| `AuditLog` | `id`; `module`; `entity`; `entityId`; `action`; `performedById?` FK; `previousValue?` Json; `newValue?` Json |

### 3.6 Enums

- `UserStatus` ACTIVE / DISABLED
- `UserRoleName` CUSTOMER / OPERATIONS / SUPER_ADMIN
- `CustomerStatus` ACTIVE / BLOCKED
- `PlanStatus` DRAFT / ACTIVE / DISABLED / ARCHIVED
- `OrderStatus` DRAFT / PAYMENT_PENDING / PAYMENT_CONFIRMED / REVIEW_PENDING / AWAITING_CUSTOMER / APPROVED / PROVISIONING / COMPLETED / PAYMENT_FAILED / CANCELLED / PROVISIONING_FAILED / REFUND_PENDING / REFUNDED
- `PaymentProvider` KHALTI
- `PaymentStatus` INITIATED / PENDING / COMPLETED / FAILED / CANCELLED / REFUNDED
- `DocumentType` PASSPORT / TICKET / VISA
- `DocumentStatus` PENDING / APPROVED / REJECTED / REUPLOAD_REQUIRED
- `InventoryStatus` IMPORTED / AVAILABLE / RESERVED / ASSIGNED / ACTIVATED / EXPIRED / TERMINATED
- `ProvisioningStatus` QUEUED / RUNNING / DELAYED / SUCCEEDED / RETRYING / FAILED
- `SubscriptionStatus` PENDING / ACTIVE / EXPIRED / TERMINATED / FAILED

---

## 4. Forms and validation

Zod schemas live in `packages/shared/src/schemas.ts`; the customer UI renders
them in `apps/customer-web/src/app/esim/checkout/checkout-client.tsx`.

### 4.1 Create order — `createOrderSchema`

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `planId` | UUID | yes | must be a UUID v4 string |
| `compatibilityAccepted` | boolean literal | yes | must be exactly `true` |

### 4.2 Traveller — `travelerSchema`

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `title` | enum | yes | `MR` \| `MS` \| `MRS` |
| `firstName` | string | yes | trimmed, 1–80 chars |
| `middleName` | string | no | trimmed, ≤80 chars |
| `surname` | string | yes | trimmed, 1–80 chars |
| `dateOfBirth` | date | yes | ISO date (zod `z.iso.date()`) |
| `nationality` | string | yes | exactly 2 chars (ISO-3166 alpha-2) |
| `city` | string | yes | trimmed, 1–100 chars |
| `countryOfResidence` | string | yes | exactly 2 chars |
| `employerOrBusinessName` | string | no | trimmed, ≤160 chars |
| `email` | email | yes | valid email |
| `mobile` | string | yes | trimmed, 7–20 chars |
| `passportNumber` | string | yes | trimmed, 5–30 chars (UI uppercases) |
| `passportExpiryDate` | date | yes | ISO date |
| `pointOfSaleCode` | string | no | trimmed, ≤40 chars (customer UI default `WEB-NP`) |

Server stores `dateOfBirth`, `passportNumber`, `passportExpiryDate`
**encrypted** (AES-256-GCM) and `passportNumberHash` as a blind index. All
other fields plaintext.

### 4.3 Document — `documentRequestSchema`

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `type` | enum | yes | `PASSPORT` \| `TICKET` \| `VISA` |
| `fileName` | string | yes | 1–180 chars |
| `contentType` | enum | yes | `application/pdf` \| `image/jpeg` \| `image/png` |

Upload constraint (enforced at `confirmDocument` via Cloudinary
`verifyDocument`, `cloudinary-storage.service.ts:30`): resource format must be
`pdf`, `jpg`, `jpeg` or `png`, and bytes must be ≤ 10 MB
(10 × 1024 × 1024). Only file type and size are validated — there is no
content review of the document.

The customer checkout also offers a **native camera capture** button
(`apps/customer-web/src/app/esim/checkout/checkout-client.tsx`): a hidden
`<input type="file" accept="image/jpeg,image/png" capture="environment">`
opens the device camera, and the captured photo follows the same signed-upload
+ confirm path.

### 4.4 Payment — `initiatePaymentSchema`

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `provider` | enum | yes | `KHALTI` |

### 4.5 Other bodies

| Endpoint | Body |
| --- | --- |
| `POST /admin/plans/import-csv` | `{ csv: string }` (required, non-empty) |
| `POST /operations/inventory/import` | `{ iccids: string[], eids?: (string\|null)[], source?: string }` |
| `POST /operations/inventory/import-csv` | `{ csv: string, source?: string }` |
| `POST /operations/orders/:id/request-reupload` | `{ reason: string }` |
| `POST /operations/orders/:id/documents/:documentId/request-reupload` | `{ reason?: string }` |
| `POST /customer/orders/:orderId/payment/simulate-complete` | `{ reference: string, scenario?: 'SUCCESS'\|'CANCELLED'\|'PENDING'\|'WRONG_AMOUNT'\|'REFUNDED'\|'TIMEOUT' }` |
| `POST /customer/orders/:orderId/payment/verify` | `{ reference: string }` |
| `PATCH /admin/plans/:id` | `{ sellingPriceNpr?: number, popular?: boolean, status?: PlanStatus }` |
| `PATCH /admin/users/:id/account-type` | `{ accountType: UserRoleName }` |
| `PATCH /admin/users/:id/status` | `{ status: UserStatus }` |
| `POST /admin/staff-invitations` | `{ email: string, accountType: UserRoleName }` |
| `POST /admin/integrations/transatel/eligibility` | `{ planId: string, msisdn: string }` (msisdn must match `/^\d{6,15}$/`) |
| `POST /operations/notifications/test` | `{ orderId?: string, channel?: 'EMAIL'\|'WHATSAPP' }` |

### 4.6 CSV formats (`apps/api/src/common/csv.util.ts`)

RFC-4180: quoted fields, escaped quotes (`""`), CRLF or LF rows. Headers are
matched case-insensitively; missing required columns produce a 400.

**Plans CSV** (`POST /admin/plans/import-csv`, ≤ 2 000 rows):

| Column | Required | Rule |
| --- | --- | --- |
| `countryIso2` | yes | `/^[A-Z]{2}$/` |
| `countryName` | no | falls back to `countryIso2` |
| `name` | yes | non-empty |
| `providerPlanId` | yes | non-empty |
| `dataAllowance` | yes | non-empty (free text, e.g. "5 GB") |
| `validityDays` | yes | integer 1–3650 |
| `costPrice` | yes | number 0–9999999999.99 |
| `sellingPrice` | yes | number 0–9999999999.99 |
| `currency` | no | default `NPR`, uppercased |
| `popular` | no | `true`/`1` → true |
| `status` | no | `DRAFT`/`DISABLED`/`ARCHIVED`, else `ACTIVE` |
| `coverageCountries` | no | `|` or `;` separated; defaults to the country name |

Upsert: `Country` by `isoCode`, `Plan` by `(countryId, providerPlanId)`.
Response `{ imported, updated, skipped, errors: string[] (≤100) }` — errors
are `Line N: <reason>`.

**Inventory CSV** (`POST /operations/inventory/import-csv`, ≤ 5 000 rows):

| Column | Required | Rule |
| --- | --- | --- |
| `iccid` | yes | `/^\d{15,25}$/` |
| `eid` | no | `/^[A-Z0-9-]{16,80}$/`; missing → synthetic `SYNTH-<sha256(iccid) hex, first 28, uppercase>` |

Skips (reported per line): invalid ICCID/EID, in-file duplicate ICCID, already
existing ICCID, already existing EID. Response
`{ imported, skipped, errors (≤100), batch }`. Batch reference
`MANUAL-CSV-<source|ops>-<UTC timestamp>`.

---

## 5. HTTP API reference (all endpoints under `/api/v1`)

Global behaviors:
- Every response is wrapped by `CorrelationInterceptor`:
  `{ data: <payload>, meta: { correlationId, timestamp } }`.
- Every error uses the envelope `{ data: null, error: { code, message, details? }, meta }`.
- Mutations (`POST/PATCH/PUT/DELETE`, non-webhook) accept an optional
  `x-idempotency-key` header (8–200 chars) scoped per user+path; replaying the
  same key with a different request body → 409 `CONFLICT`, same body → the
  stored response is returned.
- Rate limits: 300 req/min per IP+route by default; 60 req/min for `/auth` and
  `/public`; webhook routes exempt. Headers `x-ratelimit-limit`,
  `x-ratelimit-remaining`, `retry-after`.

### 5.1 Health

| Method/Path | Guard | Request | Response |
| --- | --- | --- | --- |
| `GET /health/live` | none | — | `{ status: 'ok' }` |
| `GET /health/ready` | none | — | `{ status: 'ready'\|'degraded', checks: { api, database, databaseLatencyMs?, redis } }` |

### 5.2 Auth

| Method/Path | Guard | Request | Response |
| --- | --- | --- | --- |
| `GET /auth/me` | AuthGuard | Bearer token | `{ id, clerkId, email, accountType, effectiveCapabilities, status, mfaRequired, mfaVerified, landingPortal }` |

`landingPortal` = customer web `/account/esims` for CUSTOMER, ops web `/` for
staff. Both Next.js middlewares call this endpoint to enforce portal
separation (customer portal 404s for staff and vice-versa) and MFA redirects.

### 5.3 Public catalog (unauthenticated)

| Method/Path | Query/Body | Response |
| --- | --- | --- |
| `GET /public/countries` | — | unique `{ code, name }[]` from active plans |
| `GET /public/plans` | `country?` (ISO-2) | `PlanSummary[]` ordered `popular desc, sellingPrice asc` |
| `GET /public/plans/:id` | — | `PlanSummary` or 404 `NOT_FOUND` |
| `GET /public/coverage/:country` | — | `{ available, message }` |

`PlanSummary = { id, countryCode, countryName, name, dataAllowance, validityDays, sellingPriceNpr, coverage: string[], popular }`. When the DB is off, a fixed 3-plan fallback serves AE/GB/JP.

### 5.4 Customer (AuthGuard + `@AccountTypes(CUSTOMER)`)

| Method/Path | Body/Query | Description & response |
| --- | --- | --- |
| `GET /customer/orders` | — | Redacted `Order[]` for the caller (customer view). |
| `GET /customer/orders/:id` | — | Redacted order; 404 `NOT_FOUND` if not owned. |
| `POST /customer/orders` | `createOrderSchema` | Creates DRAFT order + records `E_SIM_COMPATIBILITY` consent (v1.0) with IP + User-Agent; returns redacted order. |
| `PATCH /customer/orders/:id/traveler` | `travelerSchema` | Only in `DRAFT`; stores traveler; redacted order. |
| `POST /customer/orders/:id/documents` | `documentRequestSchema` | Only in `DRAFT`/`AWAITING_CUSTOMER`; creates/overwrites the document (one per type) and returns `{ id, type, fileName, status, upload }` where `upload` is a signed Cloudinary upload authorization (10-minute expiry) or a `local-simulator` fallback. |
| `POST /customer/orders/:id/documents/:documentId/confirm` | `{}` | Verifies the uploaded file via Cloudinary (format + ≤10 MB); if re-uploading from `AWAITING_CUSTOMER` with no other pending re-uploads, transitions order back to `REVIEW_PENDING`. |
| `POST /customer/orders/:orderId/payment` | `initiatePaymentSchema` | Validates traveler + passport + ticket present, re-verifies those documents, transitions to `PAYMENT_PENDING` (idempotent), stores the payment reference, returns the gateway initiation (reference, redirectUrl, expiresAt). |
| `POST /customer/orders/:orderId/payment/verify` | `{ reference }` | Server-side payment lookup and confirmation (used by the checkout polling loop). |
| `POST /customer/orders/:orderId/payment/simulate-complete` | simulator body | Dev only (disabled in production); applies a simulator scenario then confirms. |
| `GET /customer/orders/:id/notifications` | — | Notification list for one order. |
| `GET /customer/notifications` | — | Notification list across the caller's orders. |

### 5.5 Operations (AuthGuard + `@AccountTypes(OPERATIONS, SUPER_ADMIN)`)

| Method/Path | Description |
| --- | --- |
| `GET /operations/dashboard` | Counts (REVIEW_PENDING, AWAITING_CUSTOMER, PROVISIONING_FAILED, COMPLETED today), integration config status (Transatel/Khalti UP or CONFIG_REQUIRED), 8 recent orders. |
| `GET /operations/customers` | Grouped customers with order counts, completed eSIMs, last order date. |
| `GET /operations/audit` | Last 200 `AuditLog` rows. |
| `GET /operations/orders` | **Full** (expanded) order list — includes qrPayload, ownerId, provider ids. |
| `GET /operations/orders/:id` | Full order detail. |
| `GET /operations/orders/:id/documents/:documentId/preview` | `{ url (signed, 5-min), fileName, contentType, expiresInSeconds }` |
| `GET /operations/orders/:id/documents/:documentId/content` | Streams the raw document bytes (`no-store, private`). |
| `POST /operations/orders/:id/approve` | Requires passport AND ticket both `APPROVED`; reserves inventory; `APPROVED → PROVISIONING`; enqueues `provision-order` (or runs in-process). |
| `POST /operations/orders/:id/request-reupload` | `{ reason }`; order → `AWAITING_CUSTOMER`, all documents → `REUPLOAD_REQUIRED`. |
| `POST /operations/orders/:id/documents/:documentId/approve` | Approves one document + audit + `OrderReview`. |
| `POST /operations/orders/:id/documents/:documentId/request-reupload` | `{ reason? }` (reason required); document → `REUPLOAD_REQUIRED`, order → `AWAITING_CUSTOMER` (reason recorded `(requested by <clerkId>)`). No email is sent (template dormant); the customer sees an in-app banner. |
| `POST /operations/orders/:id/retry` | Only from `PROVISIONING_FAILED`; re-runs provisioning (`PROVISIONING`, "Manual retry"). |
| `GET /operations/integration-events` | Last 200 `WebhookEvent`s (source, eventId, signatureValid, processedAt, errorMessage) excluding idempotency entries. |
| `GET /operations/integration-logs?operation=` | Last 200 `IntegrationLog`s; optional `operation` filter. |
| `GET /operations/inventory` | `{ counts: { available, reserved, assigned, activated }, lowStockThreshold: 10, lowStock, batches (20) }` |
| `POST /operations/inventory/import` | JSON ICCID array import (≤5000). |
| `POST /operations/inventory/import-csv` | CSV inventory import. |
| `GET /operations/notifications` | All notifications. |
| `POST /operations/notifications/test` | Super Admin; enqueues an `ORDER_STATUS` notification for an order. |
| `POST /operations/notifications/:id/retry` | Re-queues a failed/simulated notification. |

### 5.6 Admin (AuthGuard + `@AccountTypes(SUPER_ADMIN)`)

| Method/Path | Description |
| --- | --- |
| `GET /admin/plans` | All plans with cost/selling price, country, status. |
| `POST /admin/plans/import-csv` | Bulk plan upsert (see §4.6). |
| `PATCH /admin/plans/:id` | Update selling price/popular/status (price must be ≥ 0). |
| `GET /admin/integrations` | Config status of Email/Khalti/Transatel/Cloudinary/WhatsApp with masked secret values. |
| `POST /admin/integrations/:id/test` | Health check per integration. |
| `POST /admin/integrations/transatel/sync-catalog` | Pulls Transatel catalog → plans (see §6.6). |
| `POST /admin/integrations/transatel/ensure-webhook` | Registers/updates the Transatel webhook (see §6.7). |
| `POST /admin/integrations/transatel/eligibility` | Checks plan eligibility for an MSISDN. |
| `GET /admin/users` | Users with effective capabilities, status, customer code. |
| `PATCH /admin/users/:id/account-type` | Staff role change (audited; cannot convert customers). |
| `PATCH /admin/users/:id/status` | Enable/disable (audited; final admin protected). |
| `GET /admin/staff-invitations` / `POST` / `POST :id/resend` / `DELETE :id` | Invitation lifecycle (audited). |

### 5.7 Partners (PartnerAuthGuard — `x-partner-api-key`, HMAC-compared against SHA-256 hashes in `PARTNER_API_KEYS_JSON`)

Documented in detail in `docs/PARTNER-API-v1.md`. Summary:

| Method/Path | Body | Notes |
| --- | --- | --- |
| `GET /partners/capabilities` | — | apiVersion, payments, notifications, connectivity.available, idempotency flag |
| `GET /partners/plans` | — | catalog |
| `POST /partners/quotes` | `{ planId }` | `{ quoteId, planId, amount, currency:'NPR', expiresAt (+15min) }` (deprecated) |
| `POST /partners/orders` | complete order body (recommended) or legacy quote body | owner id = `partner:<id>:<externalCustomerId>` |
| `GET /partners/orders/:id` | — | order for the partner's owner prefix (404 otherwise) |
| `POST /partners/orders/:id/traveler` | `travelerSchema` | |
| `POST /partners/orders/:id/documents` | `documentRequestSchema` | |
| `POST /partners/orders/:id/documents/:documentId/confirm` | — | |
| `POST /partners/orders/:id/hosted-checkout-session` | — | deprecated (410 `HOSTED_PAYMENT_DEPRECATED`) |
| `GET /partners/orders/:id/usage` | — | only after `COMPLETED` |
| `GET /partners/orders/:id/events` | — | order event history |
| `POST /partners/orders/:id/notifications` | `{ channel, template }` | re-sends a template to the traveler |

### 5.8 Webhooks (unauthenticated, signature-verified)

| Method/Path | Verification | Behavior |
| --- | --- | --- |
| `POST /webhooks/clerk` | Svix `Webhook(CLERK_WEBHOOK_SECRET)` | Returns 202; missing secret in non-prod → `{ accepted: true, simulated: true }`; calls `clerkSync.sync`. |
| `POST /webhooks/payments/:provider` | `x-visa-signature` (HMAC-SHA256, `PAYMENT_SIMULATOR_SECRET`) only in non-prod | Body `{ eventId, ... }`; dedupes by `(provider, eventId)` (in-memory set + `WebhookEvent` unique key); persists; enqueues `payment-callback`. |
| `POST /webhooks/connectivity/:provider` | `x-tsl-signature-256` (value `sha256=<hmac-sha256(secret, raw body)>`) or `x-visa-signature`; **required in production** | Body `{ eventId | header.eventId, ... }`; only `transatel` supported; dedupes; persists; enqueues `connectivity-callback`. |

All webhooks return HTTP 202 `{ accepted: true }` (plus `queued`, `duplicate`,
`simulated` flags).

---

## 6. Transatel connectivity integration

`apps/api/src/modules/integration/transatel.provider.ts`. Base URL is the API
root; domain URLs are derived: `<root>/authentication`,
`<root>/ocs/subscriptions`, `<root>/ocs/inventory`, `<root>/ocs/catalog`,
`<root>/sim-management/sims`, `<root>/webhooks`. Request timeout
`TRANSATEL_REQUEST_TIMEOUT_MS` (default 15000 ms).

### 6.1 Token exchange

- `POST <root>/authentication/api/token`, header `Authorization: Basic
  base64(clientId:clientSecret)`, body `grant_type=client_credentials`.
- Response `{ access_token, expires_in }`. Token cached until
  `expiry - 30s`; a 401 on any call forces one immediate token refresh and one
  retry.
- Failure → 503 `CONNECTIVITY_UNAVAILABLE` with customer message
  *"Our connectivity service is temporarily unavailable. Please try again shortly."*
- Every token call is logged to `IntegrationLog` (operation `token`).

### 6.2 Provisioning (OCS preload)

Request: `POST <root>/ocs/subscriptions/api/orders/products`

```json
{
  "bind": { "msisdn": "<iccid (default) or eid if TRANSATEL_SUBSCRIBER_IDENTIFIER=msisdn>" },
  "source": "VisaCompass",
  "orderType": "preload",
  "mvnoRef": "<TRANSATEL_MVNO_REF>",
  "product": { "productId": "<plan.providerPlanId>" },
  "payment": { "provider": "<TRANSATEL_PAYMENT_PROVIDER>" },  // optional
  "transactionReference": "<order.id>"
}
```

Response `OrderProductResponse`:
`{ id, orderReference, status:'done', bind:{msisdn}, source, mvnoRef, subscriptionId?, transactionReference? }`.

Then `GET <root>/sim-management/sims/api/esims/sim-serial/{iccid}` fetches the
activation QR (see §6.4).

Result mapping to the customer journey:

| Case | Behavior | Customer message (error.message) / effect |
| --- | --- | --- |
| Response ok + subscription id + QR available | order → `COMPLETED`, inventory assigned, `QR_READY` email with PDF attachment | — |
| Response ok + subscription id, **no QR** | attempt treated as delayed → throws so the job retries | on final retry: `PROVISIONING_FAILED`; customer sees generic 502 above |
| Plan missing | 404 `PLAN_NOT_AVAILABLE` | *"This plan is no longer available. Please choose another plan."* |
| Plan has no `providerPlanId` | 502 `PROVISIONING_FAILED` | *"We could not activate your eSIM right now. Our team is reviewing it and will contact you."* |
| No reserved inventory profile | 409 `INVENTORY_UNAVAILABLE` | *"No eSIM is available right now. Please try again shortly."* |
| HTTP error from provider | 502 `PROVISIONING_FAILED` (details logged) | *"We could not activate your eSIM right now. Our team is reviewing it and will contact you."* |
| Provider response missing subscription id | 502 `PROVISIONING_FAILED` | same as above |

Every attempt is recorded in `ProvisioningAttempt` (request snapshot,
response/error). Error codes are persisted as
`PROVISIONING_FAILED (HTTP 502): <internal detail>` (truncated to 2000
chars) so ops can diagnose without the raw stack reaching customers.

### 6.3 Usage

`GET <root>/ocs/inventory/api/subscriptions/products?msisdn=<iccid>&withBalances=true`

Response `{ currentLocale, productSubscriptions: [...] }` with
`balances.data[]` of `{ resourceName, resourceLabel, resourceUnit: KB|SECOND|SMS, resourceValue, resourceStartValue, resourceStartDate, resourceEndDate }`.

Mapping: sum KB balances across non-terminated subscriptions. `resourceValue
= -1` → unlimited (remaining = total). `totalMb = max(1, round(start/1024))`;
`usedMb = max(0, totalMb - remainingMb)`.

| Case | Customer message |
| --- | --- |
| HTTP error | 502 `USAGE_UNAVAILABLE` — *"Usage details are not available yet. Please check back shortly."* |
| No active subscriptions / unresolved subscriber | 404 `USAGE_UNAVAILABLE` — same message |
| No KB balances | `{ usedMb: 0, totalMb: 0 }` (no error) |

### 6.4 eSIM details (activation QR)

`GET <root>/sim-management/sims/api/esims/sim-serial/{iccid}`

Response `{ simSerial, status, statusDate?, activationCode?, eid?, matchingId?, smdpAddress?, qrCode?: { value, dataUrl } }`.

`qrPayload = qrCode.value ?? activationCode`. If present during provisioning,
the order completes immediately with the QR. On an `ACTIVATED` webhook the QR
is fetched and used to complete a still-`PROVISIONING` order.

| Case | Effect |
| --- | --- |
| QR present | order `COMPLETED`; `qrPayload` encrypted at rest; `QR_READY` email with PDF attachment |
| QR absent | provisioning returns `DELAYED`; job retries |

### 6.5 Eligibility

`GET <root>/ocs/catalog/api/cos/{cos}/products/{productId}?msisdn=<msisdn>`

Response `ProductDetails` with `canSubscribe.{allowed, errorKey?, errorMessage?}`.

| Case | Result |
| --- | --- |
| HTTP 403/404 | `{ allowed: false, errorKey: 'ELIGIBILITY_REJECTED', errorMessage: "This eSIM is not available for the number you provided. Please check and try again." }` |
| Other HTTP error | 502 `CONNECTIVITY_UNAVAILABLE` — *"Our connectivity service is temporarily unavailable. Please try again shortly."* |
| OK | `{ allowed, errorKey?, errorMessage? }` from provider |

### 6.6 Catalog sync

`GET <root>/ocs/catalog/api/cos/{cos}/products?availabilityStatus=AVAILABLE&categories=One-off` (default COS `WW_COS_UBG_MKP_EUR`, Accept-Language `en_US`).

Per product: countries ISO-3 → ISO-2 (mapped), validity (days/months → days),
allowance (GB/KB/MB → MB), price (first `subscriptionFee` tuple, currency from
tuple, converted by `TRANSATEL_FX_TO_NPR`, min NPR 1). Products without an id,
without a resolvable country, with validity ≤ 0, or without a price are
skipped. Upsert `Country` + `Plan` (key `countryId_providerPlanId`) inside a
transaction per product, setting `status: ACTIVE`, `sellingPrice = costPrice`.
Returns `{ synced, skipped }`.

### 6.7 Webhook registration

- Events (default): `OCS/PRODUCT/PRELOADED, OCS/PRODUCT/ACTIVATED,
  OCS/PRODUCT/EXPIRED, OCS/PRODUCT/TERMINATED` (`TRANSATEL_WEBHOOK_EVENTS`).
- Lists `GET <root>/webhooks/api/webhooks`; updates by id via PUT or creates
  via POST with `{ mvnoRef, status:'active', targetUrl, email, secret?,
  events }`.
- Runs at startup when `TRANSATEL_WEBHOOK_TARGET_URL` is set
  (`connectivity.service.ts:10`), and on demand via Admin.

### 6.8 Inbound webhook → order effects

`handleWebhook` normalizes the envelope
(`header.eventType` or `body.eventType`; ICCID from
`bind.msisdn`/`subscription.iccid`/`product.iccid`/serial numbers), resolves
the order via `EsimInventory.assignedOrderId`, and maps events:

| Provider event (suffix match) | Mapped status | Order/inventory/subscription effect |
| --- | --- | --- |
| `...ACTIVATED` | `ACTIVATED` | If order `PROVISIONING`: fetch QR, assign inventory, order → `COMPLETED`, `QR_READY` email with PDF attachment. Always: inventory → `ACTIVATED`, subscription → `ACTIVE` (with activatedAt/expiresAt). |
| `...PRELOADED` | `PRELOADED` | subscription → `PENDING` |
| `...EXPIRED` | `EXPIRED` | inventory → `EXPIRED`, subscription → `EXPIRED` |
| `...TERMINATED` | `TERMINATED` | inventory → `TERMINATED`, subscription → `TERMINATED` |
| `...CANCELED`/`CANCELLED` | `CANCELED` | subscription → `TERMINATED` |
| other / no ICCID / no order | — | skipped (`{ handled:false, reason }`), webhook marked processed, job succeeds |

Events that cannot be matched are not re-queued; the raw payload stays in
`WebhookEvent` for ops review.

### 6.9 Outbound audit trail

Every `authorizedFetch` records `{ operation, method, endpoint, status,
durationMs }` and, on non-OK, `errorCode: 'HTTP_<status>'` plus the first
2000 chars of the provider body. Read via
`GET /operations/integration-logs`.

---

## 7. Payment gateways (`apps/api/src/modules/payments`)

Gateway selection: `PAYMENT_MODE === 'sandbox'` or `NODE_ENV === 'production'`
→ real gateway, else the simulator.

### 7.1 Khalti (`khalti.gateway.ts`)

- **Initiate** `POST {KHALTI_BASE_URL}/epayment/initiate/`, header `Key
  <KHALTI_SECRET_KEY>`, body `{ return_url, website_url (origin of return
  url), amount: round(NPR × 100) (paisa), purchase_order_id: orderId,
  purchase_order_name: orderNumber }` → `{ pidx, payment_url, expires_at }`.
- **Verify** `POST {KHALTI_BASE_URL}/epayment/lookup/` body `{ pidx }` →
  `{ status, total_amount, transaction_id }`.
- **Verify** `POST {KHALTI_BASE_URL}/epayment/lookup/` body `{ pidx }` →
  `{ status, total_amount, transaction_id }`; `total_amount` is in paisa
  (`/100` → NPR). `transaction_id` is persisted as `providerTransactionId` on
  payment confirmation.
- Status map (compared case-insensitively — docs use both "Partially Refunded"
  and "Partially refunded"): `Completed→COMPLETED`, `Pending|Initiated→PENDING`,
  `Refunded|Partially Refunded→REFUNDED`, `Expired→FAILED`,
  `User canceled→CANCELLED`, anything else `FAILED`.
- **Refund** → Khalti Refund API
  `POST {origin}/api/merchant-transaction/{transaction_id}/refund/` where
  `{origin}/api` = `KHALTI_BASE_URL` minus `/v2` and `{transaction_id}` is the
  lookup `transaction_id` (not the pidx). Wallet full refund sends an empty
  body; a partial refund sends `{ amount }` (paisa). Success
  `{ "detail": "Transaction refund successful." }` → internal
  `refund-{transaction_id}`.
- Missing `KHALTI_SECRET_KEY` → `ApiException` `PAYMENT_PROVIDER_ERROR` (503).
- **Error handling**: every request uses a 15 s timeout
  (`KHALTI_REQUEST_TIMEOUT_MS`). Provider failures throw `ApiException`
  `PAYMENT_PROVIDER_ERROR` (502) with the provider `detail`/`error_key`/field
  messages plus HTTP status kept in `details` (logged server-side, never
  serialized). Verify maps the body `status` before any HTTP-status check, so
  Khalti's 400 outcomes (`Expired`, `User canceled`) resolve to FAILED /
  CANCELLED; a non-2xx without a body `status` (401 invalid token, 404 unknown
  `pidx`) and a 2xx without `status` both throw `PAYMENT_PROVIDER_ERROR`.
  Initiate also rejects a 2xx body missing `pidx`/`payment_url`.

### 7.2 eSewa (removed)

eSewa support was removed. The platform now integrates Khalti as the sole
payment gateway (see §7.1). There are no eSewa gateway adapters, env vars, or
`PaymentProvider.ESEWA` in the codebase.

### 7.3 Simulator (`simulator.gateway.ts`)

`initiate` → `{ reference: uuid, redirectUrl: <returnUrl>?simulated=1&reference=..., expiresAt: +30min }`.
Scenarios applied by `POST .../payment/simulate-complete` (and used by tests):
`SUCCESS`, `CANCELLED`, `PENDING`, `WRONG_AMOUNT` (completes but +1 NPR),
`REFUNDED`, `TIMEOUT` (immediate error). `verify` returns the stored record
with `providerTransactionId: sim-<reference>`.

### 7.4 Payment confirmation rules (`payments.service.ts`)

`verify` / `verifyCallback` / `simulate` all require, before confirming:

1. `order.payment.reference === reference` (else 400 *"Payment reference mismatch"*).
2. gateway lookup `status === COMPLETED`.
3. lookup `orderId === order.id` **and** `amountNpr === order.totalAmountNpr` (exact immutable NPR amount).
4. Otherwise 400 `Payment lookup did not confirm the order: <status>`.

On success: `confirmPayment` sets payment `COMPLETED`, then
`PAYMENT_PENDING → PAYMENT_CONFIRMED`, and **automatically approves and
provisions** the order (`PAYMENT_CONFIRMED → APPROVED → PROVISIONING`,
enqueueing `provision-order`). No operations review is required for a verified
payment. If the payment is already COMPLETED, confirmation is idempotent
(returns the order). Re-initiating on `PAYMENT_PENDING` is safe
(`beginPayment` only transitions when not already pending), and
`PAYMENT_FAILED → PAYMENT_PENDING` is allowed for retry. The `REVIEW_PENDING`
state is reserved for the replacement-document path: when a customer uploads a
requested replacement, `AWAITING_CUSTOMER → REVIEW_PENDING` and an operator
approves it.

---

## 8. Error catalog (customer-safe messages)

Source of truth: `packages/shared/src/errors.ts`. Every error response
carries `error.code` and `error.message`; clients render
`apiErrorMessage(code, message)`. `VALIDATION_ERROR` responses additionally
carry `error.details` as `{ field, message }[]`.

| Code | HTTP | Customer-safe message |
| --- | --- | --- |
| `UNEXPECTED` | 500 | *"Something went wrong. Please try again."* (fallback; untyped 5xx are always redacted to this) |
| `RATE_LIMITED` | 429 | *"Too many attempts. Please wait a moment and try again."* |
| `NOT_FOUND` | 404 | (Nest default; mapped to `HTTP_404` or provided message) |
| `CONFLICT` | 409 | (idempotency/order-version conflicts) |
| `VALIDATION_ERROR` | 400 | `field: message; field: message` joined |
| `AUTHENTICATION_REQUIRED` | 401 | *"Please sign in to continue."* |
| `ACCOUNT_SYNCHRONIZATION_FAILED` | 401 | *"Account synchronization failed"* (auth.guard override) |
| `ACCOUNT_DISABLED` | 403 | *"Account is disabled or blocked"* (auth.guard) / *"Your account is currently disabled. Contact support for help."* |
| `ACCOUNT_TYPE_FORBIDDEN` | 403 | *"You do not have permission to perform this action."* |
| `MFA_REQUIRED` | 403 | *"Multi-factor authentication is required"* (auth.guard) / *"Additional verification is required to continue."* |
| `PLAN_NOT_AVAILABLE` | 404 | *"This plan is no longer available. Please choose another plan."* |
| `COVERAGE_UNAVAILABLE` | — | *"Coverage is unavailable for this destination right now. Please contact support."* |
| `ORDER_NOT_FOUND` | 404 | *"We could not find this order. It may have expired."* |
| `ORDER_INVALID_STATE` | 400 | *"This order cannot be changed in its current state."* |
| `ORDER_IMMUTABLE` | 400 | *"Submitted order is immutable"* (orders.service override) |
| `COMPATIBILITY_REQUIRED` | 400 | *"Compatibility declaration is required"* |
| `TRAVELER_REQUIRED` | 400 | *"Traveller details are required before payment."* |
| `DOCUMENTS_REQUIRED` | 400 | *"Passport and travel ticket are required before payment."* |
| `DOCUMENT_NOT_FOUND` | 404 | *"Document not found"* |
| `DOCUMENT_STORAGE_UNAVAILABLE` | 503 | *"Secure document upload is temporarily unavailable. Please try again."* |
| `PAYMENT_PROVIDER_ERROR` | 502/503 | *"The payment provider is temporarily unavailable. Please try again or use another method."* |
| `PAYMENT_NOT_CONFIRMED` | 400 | *"We could not confirm your payment. Please verify with your wallet or retry."* |
| `PAYMENT_REFERENCE_MISMATCH` | 400 | *"The payment reference does not match this order."* |
| `PAYMENT_EXPIRED` | 400 | *"This payment attempt has expired. Please start a new one."* |
| `CONNECTIVITY_CONFIGURATION` | 503 | *"Connectivity service is not fully configured."* |
| `CONNECTIVITY_UNAVAILABLE` | 502/503 | *"Our connectivity provider is temporarily unavailable. Please try again shortly."* |
| `ELIGIBILITY_REJECTED` | 200 (flag) | *"This eSIM is not available for the number you provided. Please check and try again."* |
| `PRODUCT_UNAVAILABLE` | 404 | *"This plan is no longer offered by our provider. Please choose another plan."* |
| `PROVISIONING_FAILED` | 502 | *"We could not activate your eSIM right now. Our team is reviewing it and will contact you."* |
| `PROVISIONING_DELAYED` | — | (internal signal; surfaces as a retry) |
| `INVENTORY_UNAVAILABLE` | 409 | *"No eSIM is available right now. Please try again shortly."* |
| `INVENTORY_IMPORT_INVALID` | 400 | *"Invalid ICCID values: ..."* (inventory override) |
| `USAGE_UNAVAILABLE` | 404/502 | *"Usage details are not available yet. Please check back shortly."* |

Filter behavior (`api-exception.filter.ts`): typed `ApiException` messages are
always safe and preserved verbatim (even at 5xx); untyped 5xx are replaced
with the `UNEXPECTED` copy; Zod errors → `VALIDATION_ERROR` with details;
deliberate 4xx `HttpException`s are preserved. Internal detail is logged with
the correlation id and never serialized.

---

## 9. Order state machine (`apps/api/src/modules/orders/order-machine.ts`)

Allowed transitions (illegal ones throw and surface as errors):

```
DRAFT                 → PAYMENT_PENDING, CANCELLED
PAYMENT_PENDING       → PAYMENT_CONFIRMED, PAYMENT_FAILED, CANCELLED
PAYMENT_CONFIRMED     → APPROVED, REVIEW_PENDING
REVIEW_PENDING        → AWAITING_CUSTOMER, APPROVED, REFUND_PENDING
AWAITING_CUSTOMER     → REVIEW_PENDING, REFUND_PENDING
APPROVED              → PROVISIONING, REFUND_PENDING
PROVISIONING          → COMPLETED, PROVISIONING_FAILED
PROVISIONING_FAILED   → PROVISIONING (retry), REFUND_PENDING
REFUND_PENDING        → REFUNDED
PAYMENT_FAILED        → PAYMENT_PENDING, CANCELLED
CANCELLED / COMPLETED / REFUNDED  → (terminal)
```

> Note: `PAYMENT_CONFIRMED → APPROVED` is the automatic path taken by
> `confirmPayment` — a verified payment is approved without manual review.
> `PAYMENT_CONFIRMED → REVIEW_PENDING` is kept in the machine for completeness
> but is not produced by the current flow.

### What triggers each event and what it does

| Trigger | Flow |
| --- | --- |
| Customer confirms compatibility + creates order | `POST /customer/orders` → `DRAFT`, consent `E_SIM_COMPATIBILITY` v1.0 recorded (IP + UA). |
| Traveller saved | `PATCH .../traveler` → stays `DRAFT`. |
| Document uploaded + confirmed | signed Cloudinary upload → `confirmDocument` verifies bytes/format → if resuming from `AWAITING_CUSTOMER` with no other pending re-uploads → `AWAITING_CUSTOMER → REVIEW_PENDING`. |
| Payment initiated | `beginPayment` validates traveler + passport + ticket, re-verifies documents → `PAYMENT_PENDING`, stores payment row. |
| Payment webhook / verify | `verifyCallback`/`verify` gate (§7.4) → `confirmPayment` → `PAYMENT_PENDING → PAYMENT_CONFIRMED`, then **auto-approve** (`PAYMENT_CONFIRMED → APPROVED → PROVISIONING` + enqueue `provision-order`). Customer UI polls the order and the webhook also lands via the `payments` queue. |
| Ops approves a document | document → `APPROVED`, `OrderReview` + audit recorded. Used for the replacement-document path. |
| Ops requests re-upload | document → `REUPLOAD_REQUIRED`, order → `AWAITING_CUSTOMER` (reason with operator). No email is sent (the `DOCUMENT_REUPLOAD` template/notification path is dormant); the customer is prompted in-app. |
| Ops approves order | requires both passport + ticket `APPROVED` → reserve inventory (`AVAILABLE→RESERVED` atomic) → `APPROVED → PROVISIONING` → enqueue `provision-order` (or local 3-attempt loop when no Redis). Applies to replacement-document orders; verified payments are auto-approved. |
| Provisioning attempt | OCS preload → QR fetch (§6.2). Success + QR → `COMPLETED` (inventory `ASSIGNED`, subscription `PENDING`, `QR_READY` email with PDF attachment). Success no QR → retry. Failure → attempt recorded; 3rd failure → `PROVISIONING_FAILED`. |
| Transatel `ACTIVATED` webhook | completes a `PROVISIONING` order with the QR, or updates lifecycle for completed orders. |
| Transatel `EXPIRED`/`TERMINATED`/`PRELOADED` | inventory + subscription lifecycle updates only; order unchanged. |
| Ops retries | `PROVISIONING_FAILED → PROVISIONING` ("Manual retry"). |
| Reconciliation timer (default 15 min) | scans `ACTIVE` subscriptions with stale `usageLastCheckedAt`, enqueues `reconcile-usage`, polls `getUsage`, writes `usedMb`/`totalMb`/`usageLastCheckedAt`. |

Every transition pushes an `OrderEvent` (from/to/at/reason) into the timeline
persisted in DB and shown in both portals.

### 7.2 Response redaction (least-privilege)

- **Customer view** (`redact()`, `orders.service.ts:103`): strips `ownerId`,
  `providerSubscriptionId`, `providerStatus`, payment `correlationId`,
  document `privateAssetId`, and regex-strips operator clerk-ids from timeline
  reasons (`(requested by|approved by|assigned by) user_xxx`).
- **Ops view** (`expand()`): full record including `qrPayload`.
- `list(ownerId)`/`view(id, ownerId)` branch on caller; create/traveler/
  documents/confirm/payment always return the redacted customer view.

---

## 10. Notifications

`apps/api/src/modules/notification/`. Lifecycle: `enqueue` → store
`Notification` row (or memory) `QUEUED` → enqueue `deliver-notification` job
(or in-process) → `SENDING` → channel send → `SENT`/`SIMULATED`/`FAILED`.
Recipient resolves to `traveler.email` (EMAIL) or `traveler.mobile`
(WHATSAPP).

### 10.1 Templates (verbatim, `notification.templates.ts`)

| Template | Subject | Body text |
| --- | --- | --- |
| `ORDER_STATUS` | `Visa Compass order update — {orderNumber}` | `There is an update for order {orderNumber}. Sign in to view its secure timeline.` |
| `QR_READY` | `Your Visa Compass eSIM is ready — {orderNumber}` | `Your eSIM is ready for order {orderNumber}. Open the attached PDF and enter the mobile number you provided when prompted to reveal the activation QR.` |
| `DOCUMENT_REUPLOAD` | `Action required for {orderNumber}` | `A replacement travel document is required for {orderNumber}.` + optional ` Reason: {reason}` + ` Sign in to upload it securely.` — **dormant**: the trigger in `reviewDocument` is removed so no re-upload email is sent. |

### 10.2 Channels

- **Gmail** (`gmail.channel.ts`): when `NOTIFICATION_MODE === 'live'` sends
  via Gmail API with OAuth refresh-token flow (`GMAIL_CLIENT_ID/SECRET`,
  `GMAIL_REFRESH_TOKEN`, `GMAIL_FROM_ADDRESS`); RFC-2822 MIME built inline
  (multipart/mixed with base64 PDF attachment support), base64url `raw`.
  Otherwise (or missing credentials in non-prod) returns
  `{ providerMessageId: 'gmail-sim-<ts>', simulated: true }`; in production
  missing credentials → 503.
- **WhatsApp** (`whatsapp.channel.ts`): same mode gate; `POST
  {WHATSAPP_API_URL}/{WHATSAPP_PHONE_NUMBER_ID}/messages` with
  `{ messaging_product: 'whatsapp', to, type:'text', text:{body} }`, Bearer
  token.

### 10.3 When notifications are sent

| Event | Template | Channel |
| --- | --- | --- |
| Provisioning completes with QR (or ACTIVATED webhook completes order) | `QR_READY` | EMAIL (to traveler) with **password-protected PDF attachment** |
| Ops requests document re-upload | `DOCUMENT_REUPLOAD` | — (dormant; not triggered) |
| Ops test endpoint / partner notify | `ORDER_STATUS` | EMAIL or WHATSAPP |

The `QR_READY` email carries the activation QR as an attached PDF generated by
`QrPdfService` (`apps/api/src/modules/notification/qr-pdf.service.ts`). The PDF
is password-protected with the customer's **mobile number** as the password,
and disables copying/extraction. There is no in-app QR reveal: the customer
endpoint `GET /customer/orders/:id/qr` was removed, so the QR is only ever
delivered through the email attachment.

The customer notification-history page shows channel/template/status/sentAt.

---

## 11. Background jobs (`apps/api/src/jobs`)

Queues (`queues.ts`): `provisioning`, `provider-callbacks`, `payments`,
`notifications`, `reconciliation`. Common options: attempts **3**,
exponential backoff **2 000 ms**, `removeOnComplete: 500`,
`removeOnFail: 2 000`; worker concurrency `QUEUE_CONCURRENCY` (default 3).

| Queue | Job name(s) | Payload | Processor |
| --- | --- | --- | --- |
| `provisioning` | `provision-order` | `{ orderId }` | `OrdersService.processProvisioning(orderId, attemptsMade+1, >=3)` |
| `provider-callbacks` | `connectivity-callback` | `{ provider, eventId, payload }` | load payload → `handleWebhook` → `applyProviderEvent`; marks `WebhookEvent.processedAt` (+ error) |
| `payments` | `payment-callback` | `{ provider, eventId, payload }` | `verifyCallback(orderId, reference)`; marks processed |
| `notifications` | `deliver-notification` | `{ notificationId, channel, template, recipient, orderNumber, reason? }` | `SENDING` → render → gmail/whatsapp → `SENT`/`SIMULATED`/`FAILED` |
| `reconciliation` | `reconcile-usage` | `{ id }` | poll usage, update `usedMb/totalMb/usageLastCheckedAt` |

Webhook jobs are idempotent (dedupe happens at ingest via the
`(source, eventId)` unique key and the in-memory accepted-set). When Redis is
absent, `add()` returns a simulated ack and each caller executes the work
in-process (`processLocally`, `reconcile()`).

---

## 12. Security measures

- **Auth**: Clerk JWT, `authorizedParties` lock, DB-authoritative RBAC,
  per-route `requireRole`, enforced Super Admin MFA.
- **Transport/policy**: `helmet()`, strict CORS, request logging with masked
  actor ids, correlation ids.
- **Rate limiting**: per IP+route token buckets (webhooks exempt).
- **Idempotency**: `x-idempotency-key` with request-hash replay protection.
- **At-rest encryption**: AES-256-GCM (`APP_ENCRYPTION_KEY_BASE64`) for
  date-of-birth, passport number, passport expiry, QR payload; HMAC blind
  index for passport numbers (`PII_HASH_KEY`). In production a missing key
  aborts startup.
- **Webhook authenticity**: Svix for Clerk; HMAC-SHA256 signatures for
  payments (`x-visa-signature`) and Transatel (`x-tsl-signature-256`,
  required in production); timing-safe comparisons.
- **Partner API**: `x-partner-api-key` compared by timing-safe SHA-256 hash
  against `PARTNER_API_KEYS_JSON`.
- **Private documents**: signed short-lived Cloudinary uploads
  (`type: authenticated`, 10-min expiry), per-order folder, verified
  bytes/format on confirm, 5-min signed read URLs, downloads served
  `no-store, private`.
- **Least-privilege responses**: customer payloads redacted (§9 redaction).
- **Error hygiene**: internal detail logged only, 5xx redacted to
  `UNEXPECTED`.
- **Compliance**: consent recorded (type/version/IP/UA); full audit trail for
  identity + verification actions.

---

## 13. Frontend pages

### 13.1 Customer portal (`apps/customer-web`)

| Route | Page | Notes |
| --- | --- | --- |
| `/` | Landing + plan browse + compatibility check | public; fetches `/public/plans`, `/public/coverage/:country` |
| `/sign-in/[[...sign-in]]` | Clerk sign-in | |
| `/esim/checkout` | 4-step checkout (Compatibility → Traveller → Documents → Payment) | fields per §4; x-idempotency-key on every mutation; payment verification poll (30 × 3 s) that follows the order into auto-approval/activation; document uploads offer a native camera capture button; simulator box in dev |
| `/account/esims` | eSIM list with stats/filters (Ready / Processing / Needs action) | maps errors via `apiErrorMessage` |
| `/account/esims/[id]` | Order detail: status chip, timeline, documents (incl. replacement upload), emailed-QR notice | no in-app QR reveal (customer `/qr` endpoint removed); QR is delivered by email as a password-protected PDF; resumable banner for DRAFT/PAYMENT_PENDING; re-upload banner for AWAITING_CUSTOMER |
| `/account/notifications` | Notification history | |

Middleware (`customer-web/src/middleware.ts`): protects `/account(.*)` and
`/esim/checkout(.*)`; verifies the Clerk session against `/auth/me` and 404s
non-CUSTOMER accounts.

### 13.2 Operations + Admin portal (`apps/ops-web`)

| Route | Page |
| --- | --- |
| `/` | Dashboard (counts, integration status, recent orders) |
| `/orders` / `/orders/[id]` | Order list + review for exceptions (document approve/re-upload, order approve/retry, request re-upload). Verified payments auto-approve, so the queue mostly holds replacement-document and provisioning-failure cases. |
| `/inventory` | Inventory overview, JSON paste import, **CSV upload with per-row errors** |
| `/integration-events` | Inbound webhook events + processing status |
| `/integration-logs` | Outbound Transatel call logs |
| `/customers` | Customer aggregation |
| `/notifications` | Notification list, test-send, retry |
| `/audit` | Audit log |
| `/admin` | Workspace: plans (list + **CSV import** + edit), integrations (test, catalog sync, webhook, eligibility), users, staff invitations |
| `/security/[[...security]]` | Clerk MFA setup (redirect target for unverified Super Admins) |
| `/staff-onboarding`, `/sign-up`, `/sign-in` | Staff auth flows |

Middleware (`ops-web/src/middleware.ts`): public only for sign-in/sign-up/
staff-onboarding; otherwise requires an OPERATIONS/SUPER_ADMIN session and
redirects unverified-MFA Super Admins to `/security`.

---

## 14. Environment variables (`.env.example`)

| Group | Variables |
| --- | --- |
| Runtime | `NODE_ENV`, `PORT` (4000), `API_PUBLIC_URL`, `CUSTOMER_WEB_URL`, `OPS_WEB_URL` |
| Crypto | `APP_ENCRYPTION_KEY_BASE64` (32-byte base64), `PII_HASH_KEY` |
| Database | `DATABASE_URL` (CockroachDB), `PERSISTENCE_MODE` (`prisma` enables persistence) |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `BOOTSTRAP_SUPER_ADMIN_EMAIL`, `ENFORCE_SUPER_ADMIN_MFA` (default true) |
| Queues | `REDIS_URL` (empty → simulation), `QUEUE_CONCURRENCY` (3), `RECONCILIATION_INTERVAL_MINUTES` (15) |
| Hardening | `RATE_LIMIT_PER_MINUTE` (300), `AUTH_RATE_LIMIT_PER_MINUTE` (60) |
| Payments | `PAYMENT_MODE` (simulator), `PAYMENT_SIMULATOR_SECRET`, `KHALTI_BASE_URL`, `KHALTI_SECRET_KEY` |
| Transatel | `TRANSATEL_BASE_URL`, `TRANSATEL_CLIENT_ID`, `TRANSATEL_CLIENT_SECRET`, `TRANSATEL_MVNO_REF`, `TRANSATEL_COS`, `TRANSATEL_PAYMENT_PROVIDER` (none), `TRANSATEL_SUBSCRIBER_IDENTIFIER` (iccid), `TRANSATEL_FX_TO_NPR` (170), `TRANSATEL_CATALOG_SYNC_ON_STARTUP` (false), `TRANSATEL_WEBHOOK_TARGET_URL`, `TRANSATEL_WEBHOOK_CONTACT_EMAIL`, `TRANSATEL_WEBHOOK_SECRET`, `TRANSATEL_WEBHOOK_EVENTS`, `TRANSATEL_REQUEST_TIMEOUT_MS` (15000) |
| Storage | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` |
| Notifications | `NOTIFICATION_MODE` (simulator), `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_FROM_ADDRESS`, `WHATSAPP_API_URL`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` |
| Web apps | `NEXT_PUBLIC_API_URL` |
| Partners | `PARTNER_API_KEYS_JSON` (array of `{ id, keyHash }`; keyHash = lowercase hex SHA-256) |

---

## 15. Operating notes / known limitations

- The three newest migrations are committed but **not applied** to any real
  database; run `pnpm db:migrate` on a real CockroachDB before staging.
- In-memory rate limiting, webhook dedup, orders, notifications, and queue
  simulation are per-process — for multi-instance production, configure
  Redis (`REDIS_URL`) and the shared CockroachDB.
- Live provider/payment/notification credentials have not been smoke-tested;
  until then all integrations report `CONFIG_REQUIRED`/`SIMULATED` in the ops
  dashboard.
- `POST /customer/orders/:orderId/payment/simulate-complete` is disabled in
  production.
- Customer-facing copy is centralized in `apiErrorMessage` (§8) and the
  notification templates (§10.1); do not hardcode new messages outside those
  two places.
