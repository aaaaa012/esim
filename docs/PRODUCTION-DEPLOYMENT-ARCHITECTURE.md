# Visa Compass — Production Deployment Architecture (Vendor Guide)

Target audience: an MSP / platform vendor who will deploy, host, operate, or white-label this platform.

> This is the canonical, current view of the production topology. It is derived from the running code
> (`apps/api`, `apps/customer-web`, `apps/ops-web`, `packages/shared`) and its env-validation schema.
> Companion docs: `PRODUCTION-CREDENTIALS-CHECKLIST.md`, `21-operations-golive.md`,
> `TRANSATEL-OPERATIONS-RUNBOOK.md`, `ADR-001-modular-monolith.md`.

---

## 1. What this is

Visa Compass is a **modular-monolith eSIM commerce platform** for Nepal-originated travel. A customer buys a
data eSIM, pays with **Khalti**, the platform provisions the eSIM at **Transatel**, emits a **QR / password-
protected PDF**, and delivers it (and the lifetime document) to the customer by **email (Amazon SES)** and
optionally **WhatsApp**. Orders complete when the customer activates at the operator, reported back via a
Transatel event. There is also a partner-hosted/API channel for white-label resellers.

## 2. Runtime topology

```
                    ┌────────────────────────────────────────────────────────────┐
                    │                      CUSTOMER-WEB (Next.js)                │
                    │           /esim/checkout , /account/* , compatibility      │
                    └───────────────┬──────────────────────────────┬────────────┘
                                    │ HTTPS (Clerk session)        │ guest HMAC token
                                    ▼                              ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                            API — Node/NestJS (SINGLE INSTANCE)                        │
│   HTTP layer · AuthGuard/Clerk · guest HMAC · rate limits · raw-body webhooks          │
│   Domain services: orders, payments, provisioning, inventory, notifications, partners │
│   In-process BullMQ workers: provisioning, payments, notifications, reconciliation,   │
│   partner-webhooks, passport-OCR                                                   │
└───────┬─────────────────────┬───────────────────┬──────────────────┬──────────────────┘
        │                     │                   │                  │
        ▼                     ▼                   ▼                  ▼
   CockroachDB           Redis (Upstash)     Amazon S3          outbound: Khalti ·
   (system of record,    (BullMQ queues,     (document/           Transatel · Amazon SES ·
    Postgres wire)        leases)              attachment store)   WhatsApp
                                                                       ▲
   inbound webhooks: Khalti · Transatel(constant-time HMAC) · Clerk(svix) │
                          └──────────────────────────────────────────────┘
```

- **Web frontends:** `customer-web` (buyers), `ops-web` (operations/support), both Next.js.
- **API:** single Node/NestJS process that serves HTTP **and** runs the BullMQ workers in-process
  (provisioning/notification/reconciliation processors register on `OnModuleInit`).
- **Data:** CockroachDB (Postgres protocol) — the system of record. Redis (Upstash) — job queue,
  idempotency keys, cross-instance leader leases.
- **Media:** Amazon S3 — passport/ticket/visa document storage.
- **Auth:** Clerk (customer + ops identities); a token-gated HMAC "guest" checkout for logged-out buyers.

### Hard scaling constraint (important for the vendor)
`ORDER_WORKFLOW_MODE` is enforced as `single-instance`. Order state and per-order locks currently live in an
**in-memory store** inside the API process, and payment/provisioning sweeps iterate that in-memory map.
`env-validation.ts` **refuses to boot a second replica in production** (export `ORDER_WORKFLOW_MODE=single-instance`).
Horizontal scaling therefore requires making order state/verification counters DB-backed first — noted as the
known scale ceiling. Cross-pod safe state (Redis leases for partner/reconciliation sweeps) is already in place.

## 3. Build, test, health

```bash
# repo is pnpm monorepo
pnpm install
pnpm --filter @visa-compass/shared build
pnpm --filter @visa-compass/api build          # tsc + nest build
pnpm --filter @visa-compass/api test           # vitest — 26 files / 192 tests
pnpm --filter @visa-compass/customer-web typecheck
pnpm --filter @visa-compass/ops-web typecheck

# run (production contract)
NODE_ENV=production node --env-file-if-exists=.env dist/src/main.js
# NOTE: main.ts fails-closed if NODE_ENV is unset. Never boot without it.
```

Health endpoints (mounted under `/api/v1`):
- `GET /api/v1/health/live` — the process is alive.
- `GET /api/v1/health/ready` — api + database + redis status (503 if db or redis is down).

## 4. Required production environment variables

These are hard-required by `apps/api/src/infrastructure/env-validation.ts` (production schema). Missing or
invalid values **refuse to boot** (fail-closed), so a misconfigured rollout cannot silently degrade.

Secrets group (treat as credentials; rotate before go-live):
- `DATABASE_URL` (Cockroach), `REDIS_URL` (Upstash)
- `APP_ENCRYPTION_KEY_BASE64`, `PII_HASH_KEY`
- `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `CLERK_PUBLISHABLE_KEY`
- `GUEST_ORDER_SECRET` (guest checkout HMAC)
- `BOOTSTRAP_SUPER_ADMIN_EMAIL`, `BOOTSTRAP_SUPER_ADMIN_TOKEN`
- `AWS_REGION`, `AWS_S3_BUCKET` (credentials supplied by the workload IAM role)

Payments (Khalti):
- `PAYMENT_MODE=khalti` (must be literal), `KHALTI_SECRET_KEY`, `PAYMENT_WEBHOOK_SECRET`
- `KHALTI_BASE_URL` — **must NOT be `https://dev.khalti.com`** in production (validation rejects it)

Connectivity (Transatel):
- `CONNECTIVITY_PROVIDER=transatel`, `TRANSATEL_BASE_URL`, `TRANSATEL_CLIENT_ID`,
  `TRANSATEL_CLIENT_SECRET`, `TRANSATEL_MVNO_REF`, `TRANSATEL_COS`,
  `TRANSATEL_WEBHOOK_TARGET_URL`, `TRANSATEL_WEBHOOK_SECRET`

Notifications:
- `NOTIFICATION_MODE=live` (must be literal)
- `EMAIL_PROVIDER=ses`, `AWS_SES_REGION` (or `AWS_REGION`),
  `EMAIL_FROM_ADDRESS` (a verified SES identity), optional `EMAIL_REPLY_TO` and
  `AWS_SES_CONFIGURATION_SET`

Runtime/linkage:
- `NODE_ENV=production`, `PERSISTENCE_MODE=prisma`, `ORDER_WORKFLOW_MODE=single-instance`
- `API_PUBLIC_URL`, `CUSTOMER_WEB_URL`, `OPS_WEB_URL` (no localhost allowed)
- `TRUST_PROXY`, `OPS_ALERT_EMAIL` (ops alert receiver)
- Optional tuning: `KHALTI_REQUEST_TIMEOUT_MS`, `TRANSATEL_REQUEST_TIMEOUT_MS`, `QUEUE_CONCURRENCY`,
  `RECONCILIATION_INTERVAL_MINUTES`, `RATE_LIMIT_*`, `AUTH_RATE_LIMIT_*`, `BODY_LIMIT`, `PORT`

## 5. Security posture

- **Webhooks** (Khalti payments, Transatel connectivity, Clerk) verify a shared-secret signature over the
  **raw body** using constant-time compares; production rejects unsigned Transatel/Khalti requests.
- **Idempotency:** DB unique keys + optimistic `version` CAS on orders, `paymentReference`/transaction
  uniqueness, fixed BullMQ job IDs → no double-charge, no double-provision, no double-credit.
- **Fail-closed secrets:** every crypto/webhook/guest secret throws in production if absent (no dev fallback).
- **PII/QR:** encryption key-based payload storage; QR payload redacted from list views; QR PDFs are
  password-protected with the eSIM MSISDN.
- **Break-glass edge cases handled:** buffered webhook event with Redis-down re-enqueues; provisioning
  orphan recovery; stale-`QR_READY` reconciliation → activation re-fetch → auto-fail; stale payments auto-failed
  (never stuck forever); double-charge guarded at payment initiation; guest QR recovery (re-send + PDF download)
  independent of email delivery.

## 6. Go-live runbook (checked)

1. Verify the sender identity in SES, move the SES account out of sandbox, then
   set `EMAIL_PROVIDER=ses`, `AWS_SES_REGION`, `EMAIL_FROM_ADDRESS`, and
   optional `EMAIL_REPLY_TO`.
2. Point `KHALTI_BASE_URL` at production Khalti (not `dev.khalti.com`); set a real `TRANSATEL_COS`.
3. Rotate every secret under §4 **before** opening real traffic.
4. Apply schema: `prisma migrate deploy` against the production Cockroach instance.
5. Set `NODE_ENV=production`; export `ORDER_WORKFLOW_MODE=single-instance`; boot exactly **one** API instance.
6. Verify `GET /api/v1/health/ready` returns `api/database/redis = up`.
7. Bootstrap the first Super Admin (token-gated `POST /auth/bootstrap`, rate-limited).
8. Smoke a real checkout → Khalti → Transatel → Amazon SES QR → activation.

Detailed steps: see `21-operations-golive.md` and `PRODUCTION-CREDENTIALS-CHECKLIST.md`.

## 7. Observability & operations

- ops-web dashboards: orders work-queue, notifications + retry, integration events + replay, provisioning
  operations, partner API, payments, refunds.
- `integration_log` / `integration_processes` record every provider call (endpoint, status, error, duration).
- BullMQ: 3 attempts, exponential backoff + jitter; failed notification/webhook rows are DB-surfaced with
  ops retry; provisioning exhaustion sends an `OPS_ALERT_EMAIL`.
