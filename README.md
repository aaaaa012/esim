# Visa Compass eSIM Platform

Visa Compass is a TypeScript monorepo for purchasing, reviewing, provisioning, and managing travel eSIMs.

## Applications

| Workspace | Technology | Local URL |
| --- | --- | --- |
| `apps/api` | NestJS, Prisma, BullMQ | `http://localhost:4000` |
| `apps/customer-web` | Next.js App Router | `http://localhost:3000` |
| `apps/ops-web` | Next.js App Router | `http://localhost:3001` |
| `packages/shared` | Shared contracts and validation | Internal package |

API documentation is available at `http://localhost:4000/api/docs` after the API starts.

## Prerequisites

- Node.js 22 or newer
- pnpm 11.9.0 (`corepack enable` is recommended)
- A PostgreSQL 15+ connection
- A Clerk development application
- Redis with a TCP/TLS endpoint when BullMQ processing is required

Amazon S3, Amazon SES, Khalti, WhatsApp, and live connectivity-provider credentials are optional for simulator-based development.

## First-time installation

Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/Samirmajhi/Visa-compass.git
cd Visa-compass
corepack enable
pnpm install --frozen-lockfile
```

Create the single root environment file:

```bash
cp .env.example .env
```

Generate safe local encryption values:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Put the first result in `APP_ENCRYPTION_KEY_BASE64` and the second in `PII_HASH_KEY`. Then configure at least:

```dotenv
DATABASE_URL=postgresql://app_user:password@host:5432/postgres?schema=visa_compass&sslmode=require
DIRECT_DATABASE_URL=postgresql://migration_user:password@host:5432/postgres?schema=visa_compass&sslmode=require
PERSISTENCE_MODE=prisma
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
BOOTSTRAP_SUPER_ADMIN_EMAIL=separate-staff-email@example.com
```

Never commit `.env`, application `.env.local` files, API keys, OAuth tokens, database credentials, passport data, QR payloads, or activation codes.

## Database setup

Generate Prisma Client, apply migrations, and add the development catalogue:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

`db:migrate` is intended for developer databases. Production deployments should apply committed migrations through the deployment workflow rather than running interactive development migrations.

## Start development

Start the API and both portals together:

```bash
pnpm dev
```

Or start a single workspace:

```bash
pnpm --filter @visa-compass/api dev
pnpm --filter @visa-compass/customer-web dev
pnpm --filter @visa-compass/ops-web dev
```

Health checks:

```bash
curl http://localhost:4000/api/v1/health/live
curl http://localhost:4000/api/v1/health/ready
```

## Clerk configuration

Configure these development origins in Clerk:

- Customer portal: `http://localhost:3000`
- Operations portal: `http://localhost:3001`

Customer registration is public. Staff accounts are separate identities and are created through Super Admin invitations. `BOOTSTRAP_SUPER_ADMIN_EMAIL` is used only when no active Super Admin exists.

The database is authoritative for `CUSTOMER`, `OPERATIONS`, and `SUPER_ADMIN`; Clerk metadata never grants API permissions. Super Admin MFA is enabled by default. Set `ENFORCE_SUPER_ADMIN_MFA=false` only for temporary local development.

For webhook synchronization, point Clerk's user webhook to:

```text
POST <public-api-url>/api/v1/webhooks/clerk
```

Set its signing secret in `CLERK_WEBHOOK_SECRET`. Local development also performs just-in-time identity synchronization when a valid Clerk session first calls the API.

## Redis and background jobs

Without `REDIS_URL`, queue submissions use the local simulator. For BullMQ, provide a Redis TCP URL, not an Upstash REST URL:

```dotenv
REDIS_URL=rediss://default:password@host:6379
QUEUE_CONCURRENCY=3
```

Upstash Redis should use its TCP/TLS connection string. Fixed-price plans are preferable for continuously running BullMQ workers because workers poll Redis.

## Integration modes

The default development configuration uses:

- Payment gateway simulators
- Transatel connectivity (production provider; requires credentials in `.env`)
- Simulated notifications unless Amazon SES is configured
- In-process queue simulation unless `REDIS_URL` is configured

Do not claim sandbox or live-provider certification until the corresponding credentials and provider contracts have been smoke-tested.

## API hardening

- **Error contract** — every API error returns a stable machine-readable `error.code` and a customer-safe `message` (`packages/shared/src/errors.ts`). Internal detail (provider responses, stack traces) is logged server-side with the correlation ID and never sent to clients.
- **Request logging** — every request is logged with method, path, status, duration, correlation ID and a masked actor.
- **Rate limiting** — per-IP + route limits with `x-ratelimit-limit` / `x-ratelimit-remaining` headers; webhook endpoints are exempt. Tune via `RATE_LIMIT_PER_MINUTE` and `AUTH_RATE_LIMIT_PER_MINUTE`.
- **Usage reconciliation** — active Transatel subscriptions are polled for fresh usage balances on the `reconciliation` queue (`RECONCILIATION_INTERVAL_MINUTES`, default 15).
- **Health** — `/health/ready` reports real database and queue state.
- **Provider audit trail** — every outbound Transatel call (token, provisioning, usage, catalog, eligibility, webhooks) is persisted to `IntegrationLog` with HTTP status, duration, and the provider's raw error text; ops can query `GET /operations/integration-logs`. Inbound webhooks are stored in `WebhookEvent` with signature validity and processing errors.
- **Provisioning forensics** — `ProvisioningAttempt` stores the exact request snapshot, response snapshot, and a typed `errorCode` (`PROVISIONING_FAILED (HTTP 502): <provider detail>`) for every attempt.
- **Least-privilege responses** — customer order endpoints strip internal fields (`ownerId`, provider subscription IDs, Amazon S3 asset ids, payment correlation ids, operator clerk ids from timeline reasons); ops endpoints receive the full record.

## Bulk data management

- `POST /admin/plans/import-csv` — bulk upsert of plans (`countryIso2, countryName, name, providerPlanId, dataAllowance, validityDays, costPrice, sellingPrice, currency, popular, status, coverageCountries`). Changes publish to the customer catalog immediately. Column headers are case-insensitive.
- `POST /operations/inventory/import-csv` — bulk profile upload (`iccid, eid`), up to 5,000 rows, with per-line validation, in-file duplicate detection, and existing ICCID/EID skip reporting.
- `POST /operations/inventory/import` — paste-style ICCID import (existing behavior).
- Ops UI: CSV uploaders on the **Inventory** and **Admin > Plans** pages with per-row error feedback.

## Quality checks

Run the same checks used by CI:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Format changed files with:

```bash
pnpm format
```

## Repository workflow

- Branch from the latest shared branch.
- Keep real secrets in ignored environment files or an approved secret manager.
- Add or update tests with behavioral changes.
- Run typecheck, tests, and a proportional build before committing.
- Use focused commits that describe one completed implementation tranche.

Architecture decisions are recorded in [`docs/`](docs/), and the partner API contract is described in [`docs/PARTNER-API-v1.md`](docs/PARTNER-API-v1.md).

## Current development status

The platform includes the customer purchase flow, Operations review flow, database-backed Clerk RBAC, staff administration, private document handling, payment/connectivity adapters, notifications, queues, and partner API foundations. Some provider functions remain simulated or require live credentials; consult the active implementation plan before treating an integration as production-ready.
