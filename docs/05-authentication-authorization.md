# 05 — Authentication and Authorization

Primary source: `apps/api/src/common/auth.guard.ts`,
`apps/api/src/modules/identity/clerk-sync.service.ts`,
`apps/api/src/modules/identity/auth.controller.ts`,
`apps/api/src/modules/partners/partner-auth.guard.ts`.

## Identity model

There are three account types, defined both in the shared package
(`packages/shared/src/contracts.ts:1-5`, `UserRole`) and in the Prisma schema
(`apps/api/prisma/schema.prisma:14-18`, `UserRoleName`):
`CUSTOMER`, `OPERATIONS`, `SUPER_ADMIN`.

`UserRole` (shared) and `UserRoleName` (Prisma) have identical string values.

## Clerk tokens

`AuthGuard.canActivate` (`common/auth.guard.ts:60-125`):

1. Requires `Authorization: Bearer <token>` and `CLERK_SECRET_KEY`
   (`auth.guard.ts:63-68`).
2. Verifies the token via `@clerk/backend` `verifyToken`, restricting
   authorized parties to `CUSTOMER_WEB_URL` and `OPS_WEB_URL`
   (`auth.guard.ts:70-77`).
3. Calls `clerkSync.ensureUser(payload.sub)` — just-in-time identity
   synchronization (`auth.guard.ts:78`).
4. Loads the user from DB with customer include (`auth.guard.ts:79-82`);
   missing user → `401 ACCOUNT_SYNCHRONIZATION_FAILED`.
5. Disabled user or blocked customer → `403 ACCOUNT_DISABLED`
   (`auth.guard.ts:89-97`).
6. MFA verification flag from Clerk's `fva` claim: `fva[1] >= 0`
   (`auth.guard.ts:31-32,98-100`).
7. Roles: SUPER_ADMIN maps to `[SUPER_ADMIN, OPERATIONS]`, otherwise the
   single account type (`auth.guard.ts:101-104`).
8. Builds `AuthenticatedUser` with capabilities
   (`auth.guard.ts:105-115`).

Error codes used: `AUTHENTICATION_REQUIRED` (401),
`ACCOUNT_SYNCHRONIZATION_FAILED` (401), `ACCOUNT_DISABLED` (403).

## Capabilities

`capabilitiesFor` (`auth.guard.ts:18-30`):

| Account type | Capabilities                                                                   |
| ------------ | ------------------------------------------------------------------------------ |
| CUSTOMER     | `customer:portal`, `customer:orders`                                           |
| OPERATIONS   | `operations:portal`, `operations:review`, `operations:inventory`               |
| SUPER_ADMIN  | OPERATIONS capabilities + `admin:portal`, `admin:users`, `admin:configuration` |

The same mapping is duplicated in `AdminService.users`
(`modules/admin/admin.service.ts:334-346`).

## Role gating

Two complementary mechanisms:

- **`@AccountTypes(...)`** decorator (metadata) + `AccountGuard`
  (`auth.guard.ts:127-165`):
  - Reads `ACCOUNT_TYPES` metadata.
  - SUPER_ADMIN is allowed where OPERATIONS is required
    (`auth.guard.ts:144-146`).
  - **Super Admin MFA gate**: if `ENFORCE_SUPER_ADMIN_MFA !== 'false'` and the
    user is SUPER_ADMIN without MFA verified → `403 MFA_REQUIRED`
    (`auth.guard.ts:153-162`).
- **`requireRole(request, roles)`** function (`auth.guard.ts:167-184`): checks
  the computed `roles` array (so SUPER_ADMIN passes OPERATIONS checks) and
  applies the same MFA gate. Used by `OperationsController`,
  `NotificationController`, `InventoryController`, and the integration
  events/logs controllers.

## Endpoint → guard matrix

| Controller                              | Guards                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `AuthController`                        | `AuthGuard`                                                                          |
| `OrdersController`                      | `AuthGuard`, `AccountGuard` + CUSTOMER                                               |
| `OperationsController`                  | `AuthGuard`, `AccountGuard` + OPERATIONS/SUPER_ADMIN, plus `requireRole` per handler |
| `PaymentsController`                    | `AuthGuard`, `AccountGuard` + CUSTOMER                                               |
| `InventoryController`                   | `AuthGuard`, `AccountGuard` + OPERATIONS/SUPER_ADMIN + `requireRole`                 |
| `AdminController`                       | `AuthGuard`, `AccountGuard` + SUPER_ADMIN                                            |
| `NotificationController`                | `AuthGuard` (+ `requireRole` per handler)                                            |
| `OperationsIntegrationEventsController` | `AuthGuard`, `AccountGuard` + OPERATIONS/SUPER_ADMIN + `requireRole`                 |
| `OperationsIntegrationLogsController`   | same                                                                                 |
| `GuestOrdersController`                 | none (HMAC token)                                                                    |
| `PartnersController`                    | `PartnerAuthGuard`                                                                   |
| `WebhooksController`                    | none (signature verification)                                                        |
| `CatalogController`                     | none                                                                                 |
| `HealthController`                      | none                                                                                 |

## Identity synchronization (`ClerkSyncService`)

`modules/identity/clerk-sync.service.ts`.

- `sync(event)` handles `user.created` / `user.updated` / `user.deleted`
  (`clerk-sync.service.ts:26-137`).
  - `user.deleted` → user status `DISABLED` (soft, not hard delete).
  - Requires a verified primary email.
  - Existing user → update email/status, possibly promote via
    `bootstrapExistingAccount`.
  - New user → account type from the newest pending unexpired
    `StaffInvitation` for that email, else `CUSTOMER`
    (`clerk-sync.service.ts:61-69`).
  - Creates `User`, `Role` (upsert), `UserRole`, and — for customers — a
    `Customer` row with `customerCode = VC-{user.id[0:8].toUpperCase()}`
    (`clerk-sync.service.ts:86-103`).
  - Accepts the matching invitation and writes an audit log
    (`clerk-sync.service.ts:104-123`).
- **Super Admin bootstrap** (`clerk-sync.service.ts:71-85, 173-242`):
  - If `BOOTSTRAP_SUPER_ADMIN_EMAIL` matches and there are zero active Super
    Admins, the new user becomes SUPER_ADMIN.
  - For an existing empty customer with no orders/esims, it converts them to
    SUPER_ADMIN in a transaction and deletes the customer row
    (`bootstrapExistingAccount`, `clerk-sync.service.ts:216-241`).
  - If that customer already owns business records, it writes a
    `BOOTSTRAP_REQUIRES_SEPARATE_STAFF_IDENTITY` audit log and keeps them a
    customer (`clerk-sync.service.ts:195-215`).
- `ensureUser(clerkId)` — JIT sync on first authenticated request
  (`clerk-sync.service.ts:138-171`).

## `GET /auth/me`

`modules/identity/auth.controller.ts:12-30`. Returns:
`id` (local user id), `clerkId`, `email`, `accountType`,
`effectiveCapabilities`, `status`, `mfaRequired` (SUPER_ADMIN &&
`ENFORCE_SUPER_ADMIN_MFA`), `mfaVerified`, and `landingPortal`
(`http://localhost:3000/account/esims` for customers, else
`http://localhost:3001/`). Note: the landing portal URLs are hard-coded, not
derived from `CUSTOMER_WEB_URL`/`OPS_WEB_URL`.

## Partner authentication

`modules/partners/partner-auth.guard.ts`:

- Header `x-partner-api-key`.
- `PARTNER_API_KEYS_JSON` is a JSON array of `{ id, keyHash }` where `keyHash`
  is a 64-char hex (SHA-256) of the key.
- The supplied key is SHA-256 hashed and compared with `timingSafeEqual`
  against each stored hash (`partner-auth.guard.ts:13-15`).
- On success, `request.partner = { id }`. Partner orders are namespaced as
  `ownerId = partner:{id}:{externalCustomerId}` (`partners.controller.ts:34`),
  and `partnerOrder()` enforces that namespace (`partners.controller.ts:55`).

## Webhook authentication

- Clerk: Svix signature headers verified with `CLERK_WEBHOOK_SECRET`
  (`webhooks.controller.ts:25-29`).
- Payments webhook: `x-visa-signature` = HMAC-SHA256 of body with
  `PAYMENT_SIMULATOR_SECRET`, only enforced outside production
  (`webhooks.controller.ts:40,71-75`).
- Transatel connectivity webhook: `x-tsl-signature-256` (format
  `sha256=<hex>`) or `x-visa-signature`, verified with
  `TRANSATEL_WEBHOOK_SECRET`; mandatory in production
  (`webhooks.controller.ts:53-56,76`).

## Guest checkout tokens

Guest orders are not authenticated via Clerk. Each order is gated by an HMAC
token: `HMAC-SHA256(GUEST_ORDER_SECRET, orderId)` compared with
`timingSafeEqual` (`guest-orders.controller.ts:7,54-60`).

## Security notes

- The database is authoritative for account type; Clerk metadata never grants
  API permissions (`README.md` "Clerk configuration").
- `README.md` recommends a separate staff email (not a customer email) for
  Super Admin bootstrap because staff and customer identities must be
  separate (`admin.service.ts:374-377`).
