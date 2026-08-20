# 01 — System Overview

## What this system is

Visa Compass is a platform for purchasing, reviewing, provisioning, and
managing travel eSIMs. It is a pnpm monorepo containing a NestJS API, two
Next.js portals, and a shared contract package.

Source of truth: `README.md` (repository root), `apps/api/src/app.module.ts`,
`apps/api/src/main.ts`.

## Workspaces

| Workspace           | Tech                                 | Purpose                                | Local URL               |
| ------------------- | ------------------------------------ | -------------------------------------- | ----------------------- |
| `apps/api`          | NestJS, Prisma (CockroachDB), BullMQ | Business API                           | `http://localhost:4000` |
| `apps/customer-web` | Next.js App Router                   | Customer portal                        | `http://localhost:3000` |
| `apps/ops-web`      | Next.js App Router                   | Operations/admin portal                | `http://localhost:3001` |
| `packages/shared`   | TypeScript                           | Shared contracts, schemas, error codes | internal                |

Source: `README.md` "Applications" table.

## The API at a glance

- NestJS application bootstrapped in `apps/api/src/main.ts`.
- Global URL prefix `api/v1` (`main.ts:18`).
- Swagger/OpenAPI served at `api/docs` (`main.ts:24`).
- Global pipes/filters/guards/interceptors applied in `main.ts:19-22`:
  - `ValidationPipe` (whitelist + transform)
  - `ApiExceptionFilter`
  - `RateLimitGuard`
  - `CorrelationInterceptor`, `LoggingInterceptor`, `IdempotencyInterceptor`
- CORS restricted to the two portal origins (`main.ts:17`).
- `helmet()` security headers enabled (`main.ts:16`).
- Listens on `PORT` (default `4000`) (`main.ts:25`).

## Module wiring

The single `AppModule` (`apps/api/src/app.module.ts`) declares everything;
there are no feature modules. Controllers registered at `app.module.ts:56-71`,
providers at `app.module.ts:72-98`.

Controllers:

- `HealthController` — `observability/health.controller.ts`
- `AuthController` — `modules/identity/auth.controller.ts`
- `CatalogController` — `modules/catalog/catalog.controller.ts`
- `OrdersController`, `OperationsController` — `modules/orders/orders.controller.ts`
- `GuestOrdersController` — `modules/orders/guest-orders.controller.ts`
- `InventoryController` — `modules/inventory/inventory.controller.ts`
- `AdminController` — `modules/admin/admin.controller.ts`
- `PaymentsController` — `modules/payments/payments.controller.ts`
- `WebhooksController`, `OperationsIntegrationEventsController`,
  `OperationsIntegrationLogsController` — `modules/webhooks/webhooks.controller.ts`
- `PartnersController` — `modules/partners/partners.controller.ts`
- `NotificationController` — `modules/notification/notification.controller.ts`

Key services:

- `OrdersService` — in-memory order store with Prisma-backed persistence
- `OrdersPersistenceService` — DB projection of orders
- `InventoryService` — eSIM inventory
- `PaymentsService` — payment orchestration
- `AdminService` — plan/CSV, integrations, users, invitations
- `ConnectivityService` / `TransatelProvider` — eSIM provisioning
- `NotificationService` + `GmailChannel` + `WhatsappChannel` + `QrPdfService`
- `ClerkSyncService` — identity synchronization
- `CloudinaryStorageService` — private document storage
- `QueueService` + processors + `ReconciliationService` — background jobs
- `PrismaService`, `CryptoService` — infrastructure

## Runtime behavior

### Two persistence modes

`PrismaService.enabled` is `true` only when
`PERSISTENCE_MODE === 'prisma'` **and** `DATABASE_URL` is set
(`infrastructure/prisma.service.ts:7`). When disabled, the API uses in-memory
state (orders in a `Map`, notifications in a `Map`, fallback plans) and many
Prisma-backed operations become no-ops or return empty results. This behavior
is threaded through every service (`enabled` checks throughout the codebase).

### Two queue modes

`QueueService.enabled` is `Boolean(process.env.REDIS_URL)`
(`jobs/queue.service.ts:14`). Without Redis, `add()` returns `{ simulated: true }`
and callers often execute work locally in-process (e.g. provisioning
`orders.service.ts:214`, notifications `notification.service.ts:14`,
reconciliation `reconciliation.service.ts:70`).

### Simulated integrations

With default `.env.example` values, the system runs with:

- Payment simulator gateway (no Khalti credentials)
- Local document-storage simulator (no Cloudinary)
- Simulated notifications (no Gmail/WhatsApp)
- In-process queue (no Redis)

Source: `README.md` "Integration modes"; each adapter falls back to a
simulated branch when credentials are absent (`khalti.gateway.ts:9`,
`cloudinary-storage.service.ts:17-19`, `gmail.channel.ts:8`, `whatsapp.channel.ts:6`).

### Transatel connectivity is the single production connectivity provider

`ConnectivityService` wraps `TransatelProvider` only
(`modules/integration/connectivity.service.ts:8`). Design intent is
documented in `docs/ADR-002-provider-adapters.md`.

## Notable cross-cutting behaviors

- **Error contract**: all errors flow through `ApiExceptionFilter`
  (`common/api-exception.filter.ts`) which returns
  `{ data: null, error: { code, message, ... }, meta: { correlationId, timestamp } }`.
  Successful responses are wrapped as `{ data, meta }` by
  `CorrelationInterceptor` (`common/correlation.interceptor.ts:13`).
- **Idempotency**: mutations honoring `x-idempotency-key` store the response
  and replay it (`common/idempotency.interceptor.ts`).
- **Rate limiting**: per-IP+route fixed-window limiter; webhooks exempt
  (`common/rate-limit.guard.ts`).
- **Least-privilege responses**: customer-facing order views are redacted
  (`orders.service.ts:263-269`); ops views get the full record
  (`orders.service.ts:33`).

## Related documents

- Business intent: `docs/BUSINESS-OVERVIEW.md`, `docs/PLATFORM-SPECIFICATION.md`
- Modular-monolith ADR: `docs/ADR-001-modular-monolith.md`
- Provider-adapter ADR: `docs/ADR-002-provider-adapters.md`
- Sensitive-data ADR: `docs/ADR-003-sensitive-data.md`
- Jobs ADR: `docs/ADR-004-jobs.md`
