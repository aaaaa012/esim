# 13 — Data Persistence

Primary sources: `apps/api/prisma/schema.prisma`,
`apps/api/src/infrastructure/prisma.service.ts`,
`apps/api/src/infrastructure/crypto.service.ts`,
`apps/api/src/modules/orders/orders-persistence.service.ts`.

## Persistence mode

`PrismaService` (`infrastructure/prisma.service.ts`):

- `enabled = process.env.PERSISTENCE_MODE === 'prisma' && Boolean(process.env.DATABASE_URL)`
  (`prisma.service.ts:7`).
- `onModuleInit` connects when enabled, else logs "Prisma persistence
  disabled; using the local in-memory workflow store".
- DB: CockroachDB (`schema.prisma:7`, `provider = "cockroachdb"`).

When disabled, services degrade:
- Orders: in-memory `Map` (`orders.service.ts:29`), persistence calls are
  no-ops.
- Notifications: in-memory map (`notification.service.ts:12`).
- Catalog: hard-coded `FALLBACK_PLANS` (`catalog.controller.ts:4`).
- Inventory: mock reservation (`inventory.service.ts:21`), overview zeros.
- Reconciliation: skipped (`reconciliation.service.ts:43`).
- Webhooks/audit/integration logs: not persisted.

## Schema overview

`apps/api/prisma/schema.prisma` (full model list):

**Identity & staff**
- `User` (`schema.prisma:113-126`) — clerkId unique, email unique, status,
  accountType, roles, customer.
- `StaffInvitation` (`:127-142`) — email, accountType, status
  (PENDING/ACCEPTED/REVOKED/EXPIRED), clerkInvitationId unique, invitedBy,
  acceptedBy, expiresAt, acceptedAt, revokedAt.
- `Role` / `UserRole` (`:143-154`) — RBAC join.

**Commerce**
- `Customer` (`:155-171`) — customerCode unique, source
  (WEBSITE/PARTNER/KHALTI), email unique, status, consents.
- `Country` (`:172-178`), `Plan` (`:179-195`) — plan unique on
  `(countryId, providerPlanId)`.
- `Order` (`:196-228`) — orderNumber unique, orderType, status, totals,
  pricingSnapshot, compatibilityAcceptedAt, provider refs, version
  (optimistic lock), indexes on `(customerId, status)` and `(status, createdAt)`.
- `Traveler` (`:229-250`) — sensitive fields stored encrypted
  (`dateOfBirthEncrypted`, `passportNumberEncrypted`,
  `passportExpiryEncrypted`) plus `passportNumberHash` (blind index, unique).
- `TravelerDocument` (`:251-264`) — unique on `(orderId, type)`.
- `Payment` (`:265-282`) — paymentReference unique, provider,
  providerTransactionId, correlationId, amount, status, paidAt, expiresAt,
  returnUrl; unique on `(provider, providerTransactionId)`.
- `CustomerConsent` (`:411-420`) — type, version, ip, userAgent.

**eSIM**
- `InventoryBatch` (`:283-291`), `EsimInventory` (`:292-312`) — iccid unique,
  eid unique, status, assignedOrderId unique, activationCodeEncrypted,
  smDpAddress, provider refs, activatedAt, expiresAt, version.
- `CustomerEsim` (`:313-324`) — customer + inventory + order links,
  qrPayloadEncrypted.
- `Subscription` (`:325-337`) — providerSubscriptionId unique, status,
  usage fields.

**Audit / events / integrations**
- `OrderReview` (`:338-348`), `OrderEvent` (`:349-360`),
  `ProvisioningAttempt` (`:361-374`) — requestSnapshot/responseSnapshot/
  errorCode.
- `WebhookEvent` (`:375-385`) — unique on `(source, eventId)`, payload,
  signatureValid, processedAt, errorMessage.
- `IntegrationLog` (`:387-400`) — operation, method, endpoint, status,
  durationMs, errorCode, errorMessage, correlationId.
- `Notification` (`:401-410`) — channel, template, status, sentAt.
- `AuditLog` (`:421-432`) — module, entity, entityId, action, performer,
  previous/new values.

## Orders persistence

`orders-persistence.service.ts`:

- `load()` (`orders-persistence.service.ts:14-46`): reads orders with customer,
  plan+country, traveler, customerEsim+subscriptions, documents, latest
  payment, and ordered events; decrypts traveler PII and QR payload; rebuilds
  `DemoOrder`. Purchase type and topUpMobile come from the order row / pricing
  snapshot.
- `save(order)` (`orders-persistence.service.ts:48-69`): single transaction:
  1. `ensureIdentity` — upsert User+Customer for guests (`guest-{hash}` /
     `{hash}@guest.visacompass.invalid` / `G-{hash}`) or owners
     (`{hash}@local.visacompass.invalid` / `VC-{hash}`)
     (`orders-persistence.service.ts:100-114`).
  2. Upsert Country + Plan (costPrice default = 65% of sellingPrice for
     created plans).
  3. Update or create Order with optimistic-lock `version` guard
     (`orders-persistence.service.ts:56-57`).
  4. Upsert Traveler with encrypted fields and blind index.
  5. Sync TravelerDocuments (delete removed, upsert current).
  6. Upsert Payment (unique paymentReference; paidAt when completed).
  7. Recreate OrderEvents from timeline.
- `recordConsent` (`:71-76`), `provisioningAttempt` (`:78`),
  `audit()` (`:80-84`, last 200), `recordReview` (`:86-94`).
- `travelerData` encrypts DoB/passport number/expiry and stores blind-index
  hash of passport number (`orders-persistence.service.ts:96-98`).

## Crypto

`crypto.service.ts`:

- AES-256-GCM encrypt/decrypt using `APP_ENCRYPTION_KEY_BASE64`
  (required in production; non-production fallback = 32 bytes of 0x07)
  (`crypto.service.ts:6-10`).
- `encrypt` = base64url(iv).base64url(authTag).base64url(ciphertext)
  (`crypto.service.ts:11-16`).
- `blindIndex(value)` = HMAC-SHA256 with `PII_HASH_KEY` (default
  `development-only`) over trimmed uppercased input (`crypto.service.ts:23-25`).

Sensitive data handling intent: `docs/ADR-003-sensitive-data.md`.

## Idempotency storage

`IdempotencyInterceptor` (`common/idempotency.interceptor.ts`) stores the
request hash + response in `WebhookEvent` rows with source
`idempotency:{method}:{path}:{user|anonymous}` and the client-supplied
`x-idempotency-key` as the eventId (`idempotency.interceptor.ts:15-19`). A
replayed key with a different body returns 409.

## Webhook / integration event storage

`WebhookEvent` and `IntegrationLog` are written by
`WebhooksController.persistWebhook` (`webhooks.controller.ts:64-67`) and
`TransatelProvider.record` (`transatel.provider.ts:222-239`). See
`docs/15-webhooks-integration-events.md`.

## Migrations

`db:migrate` applies committed Prisma migrations
(`README.md` "Database setup"). Production should apply committed migrations
via the deployment workflow rather than interactive development migrations
(`README.md:72`).
