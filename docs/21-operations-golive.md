# Operational Go-Live Guide: Approval Workflow, Observability & Disaster Recovery

This guide describes the operator-facing features added for production go-live:
the Super Admin approval gate over SIM-profile and plan uploads, the public
`/metrics` endpoint, structured logging, Redis-aware readiness, operational
alerts, and the PostgreSQL backup / disaster-recovery runbook.

It assumes the platform described in `docs/PLATFORM-SPECIFICATION.md` and
`docs/19-observability-hardening.md`.

---

## 1. Super Admin approval gate

### Why a gate exists

A SIM profile only becomes sellable when it enters the `AVAILABLE` state (the
FIFO reservation in `InventoryService.reserve` only ever picks `AVAILABLE`).
Previously every upload row was created `AVAILABLE` immediately. Now:

- **Inventory uploads** (paste ICCIDs or CSV/Excel) create a `PENDING` batch
  and their rows in the `IMPORTED` state. Nothing is sellable until a Super
  Admin approves the batch. Approval flips the rows to `AVAILABLE`; rejection
  leaves them `IMPORTED` with the batch marked `REJECTED` so they can never be
  reserved.
- **Plan imports** land with `status = DRAFT` (not `ACTIVE`). Only a DRAFT plan
  can be approved; approval sets it to `ACTIVE` so it becomes visible in the
  customer catalogue. Rejection sets it to `ARCHIVED`.

Every decision (import, approve, reject) is written to `AuditLog`.

### Endpoints

| Method | Path                                               | Role        | Effect                          |
| ------ | -------------------------------------------------- | ----------- | ------------------------------- |
| `POST` | `/api/v1/operations/inventory/batches/:id/approve` | Super Admin | Rows `IMPORTED -> AVAILABLE`    |
| `POST` | `/api/v1/operations/inventory/batches/:id/reject`  | Super Admin | Batch `REJECTED`; rows withheld |
| `POST` | `/api/v1/admin/plans/:id/approve`                  | Super Admin | Plan `DRAFT -> ACTIVE`          |
| `POST` | `/api/v1/admin/plans/:id/reject`                   | Super Admin | Plan `DRAFT -> ARCHIVED`        |

The inventory overview now reports `counts.pending` (rows still in `IMPORTED`)
and each batch's `status`. The ops portal Inventory page lists pending batches
with Approve / Reject buttons (visible only to a Super Admin) and the
Administration > Plans page shows Approve / Reject actions on `DRAFT` plans.

### Enforcing op

The HTTP guards are the source of truth. `InventoryController.approve` /
`reject` call `requireRole(req, [UserRole.SUPER_ADMIN])`; the plan review
endpoints sit on `AdminController`, which is `@AccountTypes(UserRoleName.SUPER_ADMIN)`
only. Operators cannot approve their own uploads.

---

## 2. Public Prometheus `/metrics`

A lightweight in-memory registry is exposed in Prometheus text format:

- `GET /metrics` (public, no PII) at `{API_PUBLIC_URL}/metrics`.

Metrics include `vc_http_requests_total`, `vc_http_responses_total`,
`vc_http_request_duration_ms_sum` (per normalized route), `vc_failures_total`
labelled by `kind` (`provisioning` / `reconciliation`) and label
(`exhausted` / `usage`), plus `vc_process_uptime_seconds`.

Counters reset on restart. For durable, multi-instance aggregation and
alerting, scrape this endpoint into a real Prometheus (sample scrape config):

```yaml
scrape_configs:
  - job_name: "visa-compass-api"
    metrics_path: /metrics
    static_configs:
      - targets: ["api:4000"]
```

Alert on sustained failures, for example:

```yaml
groups:
  - name: visa-compass
    rules:
      - alert: ProvisioningExhausted
        expr: increase(vc_failures_total{kind="provisioning"}[5m]) > 0
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Provisioning retries exhausted"
```

---

## 3. Structured logging

Set `LOG_FORMAT=json` in the API environment to emit request lifecycle logs as
single-line JSON objects (`event`, `method`, `path`, `status`, `durationMs`,
`correlationId`, `actor`). The reconciliation job also emits JSON `warn` lines
on failure. `LOG_FORMAT=plain` (the default) keeps the human-readable lines.

Correlate across components with the existing `correlationId` added by
`CorrelationInterceptor`. All 5xx/4xx failures still go through
`ApiExceptionFilter` with server-side internal detail.

---

## 4. Health / readiness with Redis

`GET /health/live` always returns `{status:"ok"}` (process is up).

`GET /health/ready` now actually checks the backing stores instead of only
reporting whether Redis is _configured_:

- DB: `SELECT 1` (when persistence is enabled) — `up` / `down`.
- Redis: a short-lived `ioredis` `PING` when `REDIS_URL` is set — `up` /
  `not-configured` / `down`.

Ready is `degraded` if either dependency is `down`.

---

## 5. Operational alerts

When a provisioning run exhausts its retries (`PROVISIONING_FAILED`), the API:

1. increments `vc_failures_total{kind="provisioning",label="exhausted"}`;
2. logs a server-side error naming the order;
3. if `OPS_ALERT_EMAIL` is configured, enqueues an `OPS_ALERT` email (subject
   `[Ops Alert] PROVISIONING_FAILED: ...`).

Reconciliation failures increment
`vc_failures_total{kind="reconciliation",label="usage"}` and are logged. Set
`OPS_ALERT_EMAIL` to a monitored mailbox to receive the provisioning alerts.

---

## 6. PostgreSQL backup / disaster recovery runbook

### Recommended approach

Enable managed point-in-time recovery on Supabase or AWS RDS. Keep independent
custom-format backups for restore drills and provider-independent recovery.

### SQL dump backup (small footprint)

Use `scripts/db-backup.*` (PowerShell and Bash variants) with the elevated,
direct `DIRECT_DATABASE_URL`. The scripts:

1. run `pg_dump` for the `visa_compass` schema into a timestamped custom-format
   `.dump` file;
2. verifies the dump is non-empty;
3. keep only the requested number of recent files (default 14).

Read access to the application schema is required. Run on a schedule, e.g. cron
`0 3 * * *` or a Task Scheduler job.

Store encrypted copies outside the database provider account. Supabase and RDS
point-in-time recovery complement these dumps; they do not replace restore tests.

### Disaster recovery steps

1. **Restore the database:** create an empty PostgreSQL database and restore the
   latest dump with `pg_restore --no-owner --no-acl --dbname "$DIRECT_DATABASE_URL" backup.dump`.
2. **Bring API VIP...**: apply any pending Prisma migrations that were not yet
   shipped: `pnpm --filter api prisma:migrate`.
3. **Restore operator identity / secrets:** recreate `.env` from the secrets
   store; there are no per-user passwords in the DB (Clerk is the identity
   provider), so no user secrets are restored.
4. **Disaster** — enable Redis & queues, confirm health ready (`/health/ready`
   shows `database` and `redis` `up`).

### RPO / RTO guidance

- **RPO**: the smaller of managed PITR coverage and independent dump frequency.
- **RTO**: restore time + migration time + service start; pre-provision a
  standby cluster and load test the restore to reduce this.

### Restore verification (don't skip)

1. Run a **restore drill** at least monthly into a scratch schema/database.
2. Validate row counts on the restored cluster against the last logs.
3. Confirm `/metrics`-visible counts (orders, profiles, etc.) match.

---

## 7. Go-live checklist

- [ ] Apply migrations to a real PostgreSQL: `pnpm --filter api prisma:migrate`.
- [ ] Set `NODE_ENV=production`, `TRUST_PROXY`, `REDIS_URL`, `OPS_ALERT_EMAIL`.
- [ ] Configure real secrets: `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`,
      `BOOTSTRAP_SUPER_ADMIN_TOKEN`, Khalti, Transatel, Cloudinary, Resend.
- [ ] Set `STAFF_EMAIL_DOMAIN` (default `visacompassnepal.com`) — staff accounts are
      pre-provisioned by a Super Admin at this domain; there is no public staff sign-up.
- [ ] Point `/metrics` at a Prometheus scrape and add the failure alert rules.
- [ ] Enable managed PITR, schedule nightly `pg_dump`, and run a monthly restore drill.
