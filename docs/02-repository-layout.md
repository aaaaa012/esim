# 02 — Repository Layout

## Top-level structure

```
.
├── apps/
│   ├── api/            # NestJS API
│   ├── customer-web/   # Next.js customer portal
│   └── ops-web/        # Next.js operations portal
├── packages/
│   └── shared/         # Shared contracts/schemas/errors
├── docs/               # Documentation (ADRs, business, API, journeys)
├── .env.example        # Template environment (only tracked env file)
├── package.json        # Root scripts and dev-dependency tooling
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json  # Shared TypeScript config
├── turbo.json          # Turborepo task graph
├── .gitignore
├── .prettierignore
└── README.md
```

Confirmed by reading the root listing. `.env` (the real secrets file) is
gitignored (`README.md:60`, `.gitignore`); only `.env.example` is tracked.

## Root workspace

`pnpm-workspace.yaml` defines the workspaces (`apps/*`, `packages/*`).
`turbo.json` defines the task graph:

- `build` — depends on `^build`; outputs `dist/**`, `.next/**`
- `dev` — `cache: false`, `persistent: true`
- `lint`, `test`, `typecheck` — cascade through dependencies

## Root scripts (`package.json`)

| Script        | Command                                           |
| ------------- | ------------------------------------------------- |
| `build`       | `turbo build`                                     |
| `dev`         | `turbo dev`                                       |
| `lint`        | `turbo lint`                                      |
| `test`        | `turbo test`                                      |
| `typecheck`   | `turbo typecheck`                                 |
| `format`      | `prettier --write .`                              |
| `db:generate` | `pnpm --filter @visa-compass/api prisma:generate` |
| `db:migrate`  | `pnpm --filter @visa-compass/api prisma:migrate`  |
| `db:seed`     | `pnpm --filter @visa-compass/api prisma:seed`     |

## `apps/api` layout

Source files under `apps/api/src`:

- `main.ts` — bootstrap
- `app.module.ts` — root module wiring
- `common/` — cross-cutting:
  - `auth.guard.ts`, `api-exception.filter.ts`, `api-error.ts`
  - `idempotency.interceptor.ts`, `correlation.interceptor.ts`,
    `logging.interceptor.ts`, `rate-limit.guard.ts`
  - `csv.util.ts` (+ `.test.ts`)
- `infrastructure/` — `prisma.service.ts`, `crypto.service.ts`,
  `cloudinary-storage.service.ts`
- `jobs/` — `queues.ts`, `queue.service.ts`, `provisioning.processor.ts`,
  `integration.processor.ts`, `reconciliation.service.ts`
- `modules/`
  - `identity/` — `auth.controller.ts`, `clerk-sync.service.ts`
  - `catalog/` — `catalog.controller.ts`
  - `orders/` — `orders.service.ts`, `orders.controller.ts`,
    `orders-persistence.service.ts`, `order-machine.ts`,
    `guest-orders.controller.ts`
  - `inventory/` — `inventory.service.ts`, `inventory.controller.ts`
  - `payments/` — `payments.service.ts`, `payments.controller.ts`,
    `payment-gateway.ts`, `gateways/{simulator,khalti}.gateway.ts`
  - `admin/` — `admin.service.ts`, `admin.controller.ts`
  - `partners/` — `partners.controller.ts`, `partner-auth.guard.ts`
  - `integration/` — `connectivity.service.ts`, `connectivity-provider.ts`,
    `transatel.provider.ts`
  - `notification/` — `notification.service.ts`, `notification.controller.ts`,
    `notification.templates.ts`, `gmail.channel.ts`, `whatsapp.channel.ts`,
    `qr-pdf.service.ts`
  - `webhooks/` — `webhooks.controller.ts`
- `observability/` — `health.controller.ts`
- `prisma/` — `schema.prisma`

Tests are colocated as `*.test.ts` files.

## Frontend layout

`apps/customer-web/src/app/`:

- `layout.tsx`, `page.tsx`, `authenticated-api-provider.tsx`,
  `customer-header.tsx`, `catalog-plans.tsx`, `topup-lookup.tsx`
- `sign-in/[[...sign-in]]/page.tsx`
- `compatibility/page.tsx`
- `esim/checkout/page.tsx` + `checkout-client.tsx`
- `account/esims/page.tsx` + `esim-list.tsx`
- `account/esims/[id]/page.tsx` + `esim-details.tsx`
- `account/notifications/page.tsx` + `notification-history.tsx`

`apps/ops-web/src/app/`:

- `layout.tsx`, `page.tsx`, `ops-shell.tsx`, `ops-sidebar.tsx`,
  `dashboard-client.tsx`, `theme-toggle.tsx`,
  `authenticated-api-provider.tsx`
- `sign-in/[[...sign-in]]/page.tsx`, `sign-up/[[...sign-up]]/page.tsx`
- `security/[[...security]]/page.tsx`, `staff-onboarding/page.tsx`
- `orders/page.tsx` + `orders-client.tsx`; `orders/[id]/page.tsx` + `review.tsx`
- `work-queue/page.tsx`
- `customers/page.tsx` + `customers-client.tsx`;
  `customers/[ownerId]/page.tsx` + `customer-profile-client.tsx`
- `inventory/page.tsx` + `inventory-client.tsx`
- `admin/page.tsx` + `workspace.tsx`; `admin/integrations/page.tsx` +
  `integrations-client.tsx`
- `notifications/page.tsx` + `notifications-client.tsx`
- `audit/page.tsx` + `audit-client.tsx`
- `integration-events/page.tsx` + `integration-events-client.tsx`

## `packages/shared`

- `index.ts` — re-exports
- `contracts.ts` — enums and types
- `schemas.ts` — Zod validation schemas
- `errors.ts` — error-code taxonomy and messages
- `contracts.test.ts`

## Tooling

- Node.js 22+, pnpm `11.9.0` (`README.md` "Prerequisites")
- Prettier for formatting (root `format` script)
- TypeScript via shared `tsconfig.base.json`
- Turborepo for orchestration

## Quality gates

CI-relevant checks from `README.md` "Quality checks":

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm format
```

`turbo.json` maps `test` and `typecheck` to depend on upstream `build`
outputs, so shared-package changes propagate before dependent apps compile.
