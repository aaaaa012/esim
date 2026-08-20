# Production resilience runbook

PostgreSQL is the lifecycle source of truth. Redis transports durable outbox work; a Redis outage must not change a confirmed business result into a failure.

## Processes

- API: `PROCESS_ROLE=api pnpm --filter @visa-compass/api start`
- Workflow worker: `PROCESS_ROLE=workflow-worker pnpm --filter @visa-compass/api start:workflow-worker`
- OCR worker: `PROCESS_ROLE=ocr-worker pnpm --filter @visa-compass/api start:ocr-worker`

All processes share `DATABASE_URL`, `REDIS_URL`, encryption keys, provider credentials, Cloudinary credentials, and notification credentials. The workflow worker consumes provisioning, callbacks, notifications, reconciliation, partner webhooks, and identity callbacks. OCR remains isolated at concurrency one.

## Recovery rules

- `PAYMENT_REVIEW_REQUIRED`: recheck the payment provider; never create another charge or mark paid manually.
- `ACTIVATION_ATTENTION`: preserve the delivered QR and reconcile Transatel; do not release inventory automatically.
- Inventory is sellable only after a fresh provider state of `available` or `allocated`.
- Replay callbacks and reconcile provisioning from the Attention queue. Every action is audited.
- `NO_REVIEW` may only be selected explicitly by Super Admin; infrastructure failure always falls back to manual review.

Monitor `/api/v1/operations/attention/platform-health` for worker heartbeats, queue age/depth, pending outbox messages, dead letters, dependencies, and open attention cases.
