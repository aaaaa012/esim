# 04 — API Surface

All routes are prefixed with `api/v1` (`apps/api/src/main.ts:18`). Swagger is
served at `api/docs` (`main.ts:24`). Response envelopes and error contract are
described in `docs/16-shared-contracts.md` and `docs/19-observability-hardening.md`.

Endpoint inventory below is complete as of the reading of each controller file.
Auth columns reference the guards applied (see `docs/05-authentication-authorization.md`).

## Conventions

- Global prefix: `api/v1`
- Success body: `{ data, meta: { correlationId, timestamp } }`
- Error body: `{ data: null, error: { code, message, details? }, meta }`
- Idempotency: POST/PATCH/PUT/DELETE honor `x-idempotency-key` when provided
  (`common/idempotency.interceptor.ts`)
- Rate limits: webhook routes exempt; `auth`/`public` stricter
  (`common/rate-limit.guard.ts:30-33`)

## Health (public, no auth)

From `apps/api/src/observability/health.controller.ts`.

| Method | Path            | Behavior                                                                                  |
| ------ | --------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/health/live`  | `{ status: 'ok' }`                                                                        |
| GET    | `/health/ready` | Checks DB (`up`/`down`/`not-configured`), reports redis config; `ready` unless DB is down |

## Identity (auth required)

From `apps/api/src/modules/identity/auth.controller.ts`. Guarded by `AuthGuard`.

| Method | Path       | Behavior                                                                                                                   |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/auth/me` | Returns local user id, clerkId, email, accountType, effectiveCapabilities, status, mfaRequired, mfaVerified, landingPortal |

## Public catalog (no auth)

From `apps/api/src/modules/catalog/catalog.controller.ts`.

| Method | Path                        | Behavior                                                                     |
| ------ | --------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/public/countries`         | List of `{ code, name }` from active plans                                   |
| GET    | `/public/plans`             | Optional `?country=CC` filter; active plans ordered popular-first then price |
| GET    | `/public/plans/:id`         | Single active plan or 404                                                    |
| GET    | `/public/coverage/:country` | `{ available, message }` based on whether plans exist for country            |

## Customer orders (auth: CUSTOMER)

From `apps/api/src/modules/orders/orders.controller.ts:10-23`.
Guards: `AuthGuard`, `AccountGuard` with `@AccountTypes(CUSTOMER)`.

| Method | Path                                                 | Behavior                                                                                                                                              |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/customer/orders`                                   | Redacted list for the signed-in user                                                                                                                  |
| GET    | `/customer/orders/:id`                               | Redacted single order (404 if not owned)                                                                                                              |
| POST   | `/customer/orders`                                   | Create order. Body `{ planId, compatibilityAccepted: true }`; optional `mobile`/`email` captured for guests; records consent if ip/user-agent present |
| PATCH  | `/customer/orders/:id/traveler`                      | Set traveler (`travelerSchema`) when DRAFT                                                                                                            |
| POST   | `/customer/orders/:id/documents`                     | Create signed document upload (`documentRequestSchema`)                                                                                               |
| POST   | `/customer/orders/:id/documents/:documentId/confirm` | Verify document uploaded (returns `{ id, type, status, uploadVerified: true }`)                                                                       |
| PATCH  | `/customer/orders/:id/cancel`                        | Cancel (DRAFT/PAYMENT_PENDING/PAYMENT_FAILED)                                                                                                         |
| POST   | `/customer/orders/:id/payment/abandon`               | Resolve payment failure (default reason `Payment abandoned by customer`)                                                                              |

## Operations (auth: OPERATIONS/SUPER_ADMIN)

From `apps/api/src/modules/orders/orders.controller.ts:25-49` (`OperationsController`).
All handlers call `requireRole(OPERATIONS, SUPER_ADMIN)` in addition to
`AccountGuard`.

| Method | Path                                                            | Behavior                                                                                                              |
| ------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/operations/dashboard`                                         | Counts (reviewPending, awaitingCustomer, provisioningFailed, completedToday) + integration statuses + 8 recent orders |
| GET    | `/operations/customers`                                         | Customers grouped from orders (name, email, order count, completedEsims, lastOrderAt)                                 |
| GET    | `/operations/customers/:ownerId`                                | `customerProfile(ownerId)` — DB-backed profile or in-memory list                                                      |
| POST   | `/operations/orders/:id/usage/refresh`                          | Pull fresh usage from connectivity provider                                                                           |
| GET    | `/operations/audit`                                             | Audit log (last 200)                                                                                                  |
| GET    | `/operations/orders`                                            | Full order list (unredacted)                                                                                          |
| GET    | `/operations/orders/:id`                                        | Full single order                                                                                                     |
| GET    | `/operations/orders/:id/documents/:documentId/preview`          | Signed read URL (300s) + fileName + contentType                                                                       |
| GET    | `/operations/orders/:id/documents/:documentId/content`          | Raw document bytes with inline disposition                                                                            |
| POST   | `/operations/orders/:id/approve`                                | Approve order; reserves inventory and enqueues provisioning                                                           |
| POST   | `/operations/orders/:id/request-reupload`                       | Move to AWAITING_CUSTOMER, mark all docs REUPLOAD_REQUIRED. Body `{ reason }`                                         |
| POST   | `/operations/orders/:id/documents/:documentId/approve`          | Approve individual document                                                                                           |
| POST   | `/operations/orders/:id/documents/:documentId/request-reupload` | Individual document re-upload. Body `{ reason }` optional                                                             |
| POST   | `/operations/orders/:id/retry`                                  | Retry provisioning after PROVISIONING_FAILED                                                                          |
| POST   | `/operations/orders/:id/cancel`                                 | Cancel (default reason `Cancelled by operations`)                                                                     |
| POST   | `/operations/orders/:id/payment/fail`                           | Resolve payment failure. Body `{ reason }`                                                                            |
| POST   | `/operations/orders/:id/payment/refund`                         | Initiate refund. Body `{ reason }`                                                                                    |
| GET    | `/operations/topup/lookup?mobile=`                              | Top-up subscriber lookup by mobile                                                                                    |
| POST   | `/operations/payments/expire-stale`                             | Expire stale pending payments; returns `{ expired }`                                                                  |
| GET    | `/operations/transatel`                                         | Consolidated provider health, subscriber balances, unassigned inventory, failures, and lifecycle history              |
| POST   | `/operations/transatel/orders/:id/suspend`                      | Idempotent audited suspension. Body `{ reason, idempotencyKey }`; Operations or Super Admin                           |
| POST   | `/operations/transatel/orders/:id/reactivate-request`           | Requests reactivation of a suspended subscriber; Operations or Super Admin                                            |
| POST   | `/operations/transatel/reactivations/:id/approve`               | A different Super Admin approves and submits the reactivation to Transatel                                            |
| POST   | `/operations/transatel/reactivations/:id/reject`                | A different Super Admin rejects with a reason; nothing is sent to Transatel                                           |
| POST   | `/operations/transatel/orders/:id/terminate`                    | Irreversible idempotent termination. Body `{ reason, idempotencyKey }`; Super Admin only                              |

## Guest orders (no login; HMAC header)

After creation, every order-specific guest endpoint requires
`x-guest-order-token`. The token is never accepted in the URL or JSON body.

From `apps/api/src/modules/orders/guest-orders.controller.ts:12-61`.
All mutations require a per-order HMAC `token` bound to `GUEST_ORDER_SECRET`.

| Method | Path                                              | Behavior                                                                                            |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| POST   | `/guest/orders`                                   | Create order without an owner; returns `{ order, token }`. Optional `mobile`, `email`               |
| GET    | `/guest/orders/:id`                               | Customer-redacted order view                                                                        |
| PATCH  | `/guest/orders/:id/traveler`                      | Traveler body                                                                                       |
| POST   | `/guest/orders/:id/documents`                     | Body `{ type, fileName, contentType? }`                                                             |
| POST   | `/guest/orders/:id/documents/:documentId/confirm` | Empty body                                                                                          |
| POST   | `/guest/orders/:id/payment`                       | Body `{ provider }`                                                                                 |
| POST   | `/guest/orders/:id/payment/verify`                | Body `{ reference }`                                                                                |
| POST   | `/guest/orders/:id/payment/simulate`              | Body `{ reference, scenario? }` (scenario: SUCCESS/CANCELLED/PENDING/WRONG_AMOUNT/REFUNDED/TIMEOUT) |
| POST   | `/guest/orders/:id/payment/abandon`               | Body `{ reason? }`                                                                                  |
| POST   | `/guest/orders/:id/cancel`                        | Body `{ reason? }`                                                                                  |
| POST   | `/guest/orders/topup-lookup`                      | Body `{ mobile }` — subscriber lookup (no token)                                                    |

## Payments (auth: CUSTOMER)

From `apps/api/src/modules/payments/payments.controller.ts:7-15`.

| Method | Path                                                  | Behavior                                        |
| ------ | ----------------------------------------------------- | ----------------------------------------------- |
| POST   | `/customer/orders/:orderId/payment`                   | Initiate payment. Body `{ provider: 'KHALTI' }` |
| POST   | `/customer/orders/:orderId/payment/simulate-complete` | Body `{ reference, scenario? }`                 |
| POST   | `/customer/orders/:orderId/payment/verify`            | Body `{ reference }`                            |

## Inventory (auth: OPERATIONS/SUPER_ADMIN)

From `apps/api/src/modules/inventory/inventory.controller.ts:7-25`.

| Method | Path                               | Behavior                                          |
| ------ | ---------------------------------- | ------------------------------------------------- |
| GET    | `/operations/inventory`            | Counts by status, low-stock flag, last 20 batches |
| POST   | `/operations/inventory/import`     | Body `{ iccids: string[], eids?, source? }`       |
| POST   | `/operations/inventory/import-csv` | Body `{ csv, source? }`                           |

## Admin (auth: SUPER_ADMIN only)

From `apps/api/src/modules/admin/admin.controller.ts:22-99`.

| Method | Path                                         | Behavior                                                      |
| ------ | -------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/admin/plans`                               | Plans with country, prices, status                            |
| POST   | `/admin/plans/import-csv`                    | Body `{ csv }` bulk upsert (≤2000 rows)                       |
| PATCH  | `/admin/plans/:id`                           | Body `{ sellingPriceNpr?, popular?, status? }`                |
| GET    | `/admin/integrations`                        | Integration statuses (email, khalti, transatel, S3, whatsapp) |
| POST   | `/admin/integrations/:id/test`               | Test integration configuration                                |
| POST   | `/admin/integrations/transatel/sync-catalog` | Sync Transatel catalog                                        |
| POST   | `/admin/integrations/transatel/eligibility`  | Body `{ planId, msisdn }` eligibility check                   |
| GET    | `/admin/users`                               | Users with roles, capabilities, customerCode                  |
| PATCH  | `/admin/users/:id/account-type`              | Body `{ accountType }` (OPERATIONS/SUPER_ADMIN)               |
| PATCH  | `/admin/users/:id/status`                    | Body `{ status }`                                             |
| GET    | `/admin/staff-invitations`                   | Invitation list                                               |
| POST   | `/admin/staff-invitations`                   | Body `{ email, accountType }`                                 |
| POST   | `/admin/staff-invitations/:id/resend`        | Amazon SES invitation                                         |
| DELETE | `/admin/staff-invitations/:id`               | Revoke invitation                                             |

## Partners (partner API key)

From `apps/api/src/modules/partners/partners.controller.ts:16-56`.
Guarded by `PartnerAuthGuard` (`X-Partner-Api-Key`). Partner orders use
`ownerId = partner:{id}:{externalCustomerId}`.

| Method | Path                                                 | Behavior                                                                                               |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/partners/capabilities`                             | apiVersion, payments, notifications, connectivity.available, idempotencyRequiredForMutations           |
| GET    | `/partners/plans`                                    | Active plans                                                                                           |
| POST   | `/partners/quotes`                                   | Body `{ planId }` → `{ quoteId, planId, amount, currency, expiresAt (15min) }`                         |
| POST   | `/partners/orders`                                   | Body `{ planId, externalCustomerId, settlement.method: PARTNER_ACCOUNT, compatibilityAccepted: true }` |
| GET    | `/partners/orders/by-external-id/:externalOrderId`   | Order status (partner-scoped)                                                                          |
| GET    | `/partners/orders/:id`                               | Order status (partner-scoped)                                                                          |
| POST   | `/partners/orders/:id/traveler`                      | Set traveler                                                                                           |
| POST   | `/partners/orders/:id/documents`                     | Add document                                                                                           |
| POST   | `/partners/orders/:id/documents/:documentId/confirm` | Confirm document                                                                                       |
| POST   | `/partners/orders/:id/hosted-checkout-session`       | Deprecated (410 `HOSTED_PAYMENT_DEPRECATED`)                                                           |
| POST   | `/partners/orders/:id/payment-session`               | Deprecated (410 `HOSTED_PAYMENT_DEPRECATED`)                                                           |
| GET    | `/partners/orders/:id/esim`                          | eSIM details when available                                                                            |
| POST   | `/partners/orders/:id/cancel`                        | Cancel order                                                                                           |
| POST   | `/partners/orders/:id/refund-requests`               | Request refund                                                                                         |
| GET    | `/partners/orders/:id/usage`                         | Usage (only when COMPLETED)                                                                            |
| GET    | `/partners/orders/:id/events`                        | Order event history                                                                                    |
| POST   | `/partners/orders/:id/notifications`                 | Body `{ channel: EMAIL\|WHATSAPP, template: ORDER_STATUS\|QR_READY\|DOCUMENT_REUPLOAD }`               |
| GET    | `/partners/account`                                  | Partner account balance/limits                                                                         |
| GET    | `/partners/ledger`                                   | Partner ledger                                                                                         |
| POST   | `/partners/hosted-checkout-sessions`                 | Deprecated (410 `HOSTED_PAYMENT_DEPRECATED`)                                                           |
| POST   | `/partners/document-upload-sessions`                 | Create document upload session                                                                         |

## Notifications (auth)

From `apps/api/src/modules/notification/notification.controller.ts:8-17`.
Guarded by `AuthGuard`.

| Method | Path                                  | Access                 | Behavior                                             |
| ------ | ------------------------------------- | ---------------------- | ---------------------------------------------------- |
| GET    | `/customer/orders/:id/notifications`  | owner                  | Notifications for one order                          |
| GET    | `/customer/notifications`             | owner                  | Notifications for all of user's orders               |
| GET    | `/operations/notifications`           | OPERATIONS/SUPER_ADMIN | All notifications (last 200)                         |
| POST   | `/operations/notifications/test`      | SUPER_ADMIN            | Send ORDER_STATUS test. Body `{ orderId, channel? }` |
| POST   | `/operations/notifications/:id/retry` | OPERATIONS/SUPER_ADMIN | Re-queue a notification                              |

## Webhooks (signature-verified)

From `apps/api/src/modules/webhooks/webhooks.controller.ts:13-77`. Rate limit
exempt. Returns HTTP 202.

| Method | Path                               | Verification                                                                                   | Behavior                                                                                                                                      |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/webhooks/clerk`                  | Svix via `CLERK_WEBHOOK_SECRET`; simulated (accepted) when not configured and not production   | Synchronizes user lifecycle (`clerk-sync.service.ts`)                                                                                         |
| POST   | `/webhooks/payments/:provider`     | Optional merchant-specific Khalti integration; required `x-visa-signature` HMAC over raw bytes | Persists durable inbox event + enqueues payment/dispute callback processing; Fonepay uses WebSocket signal plus status lookup, not this route |
| POST   | `/webhooks/connectivity/:provider` | `x-tsl-signature-256` or `x-visa-signature`; required in production                            | Persists event + enqueues `providerCallbacks` job `connectivity-callback` (Transatel only)                                                    |

## Integration events & logs (auth: OPERATIONS/SUPER_ADMIN)

From `apps/api/src/modules/webhooks/webhooks.controller.ts:79-93`.

| Method | Path                             | Behavior                                                 |
| ------ | -------------------------------- | -------------------------------------------------------- |
| GET    | `/operations/integration-events` | Last 200 webhook events (excluding idempotency sources)  |
| GET    | `/operations/integration-logs`   | Last 200 integration logs; optional `?operation=` filter |

## Omitted / not determinable

- Swagger DTO schemas for individual responses are generated from the code
  (`main.ts:24`) and are not separately documented here.
- `CustomerSource` value `KHALTI` exists in the Prisma schema
  (`schema.prisma:25-29`) but no code path was found that sets a customer
  source from a payment provider. See `docs/20-documentation-gaps.md`.
