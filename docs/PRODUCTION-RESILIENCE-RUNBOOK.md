# Production resilience runbook

PostgreSQL is the lifecycle source of truth. Redis transports durable outbox work; a Redis outage must not change a confirmed business result into a failure.

## Processes

- API: `PROCESS_ROLE=api pnpm --filter @visa-compass/api start`
- Workflow worker: `PROCESS_ROLE=workflow-worker pnpm --filter @visa-compass/api start:workflow-worker`
- OCR worker: `PROCESS_ROLE=ocr-worker pnpm --filter @visa-compass/api start:ocr-worker`

All processes share `DATABASE_URL`, `REDIS_URL`, encryption keys, provider credentials, Amazon S3 credentials, and notification credentials. The workflow worker consumes provisioning, callbacks, notifications, reconciliation, partner webhooks, and identity callbacks. OCR remains isolated at concurrency one.

The API Dockerfile builds one immutable backend image for all three roles. Use
its default command for the API, override the command with
`pnpm start:workflow-worker` for workflow/reconciliation, and with
`pnpm start:ocr-worker` for OCR. Set `NODE_ENV=production` and the appropriate
`PROCESS_ROLE` on every service; backend processes refuse ambiguous startup
without an explicit `NODE_ENV`.

## Recovery rules

- `PAYMENT_REVIEW_REQUIRED`: recheck the payment provider; never create another charge or mark paid manually.
- `ACTIVATION_ATTENTION`: preserve the delivered QR and reconcile Transatel; do not release inventory automatically.
- Inventory is sellable only after a fresh provider state of `available` or `allocated`.
- Releasing a provider-unbound reservation moves it to
  `PENDING_PROVIDER_CHECK`, clears the provider-check timestamp, and makes it
  eligible for immediate reconciliation. It never returns directly to sale.
- Bulk reconciliation always includes a locally `AVAILABLE` profile whose
  stored provider state is missing or unsafe, even when its timestamp is recent.
- A definitive, provider-unbound eSIM rejection may reserve another fresh safe
  profile up to `MAX_PROVISIONING_PROFILE_SWAPS`. The rejected profile is
  quarantined and each replacement advances the durable provider idempotency
  generation. Ambiguous outcomes and provider-bound profiles are never swapped.
- Paid orders with no safe inventory remain `PROVISIONING`, are retried by reconciliation, and create `INVENTORY_SHORTAGE` attention. They are not changed to a terminal failure.
- Reservations older than `INVENTORY_RESERVATION_STALE_HOURS` are released only when the order is terminal and no provider submission evidence exists. Every ambiguous reservation stays locked.
- Payment verification attempt counts live on the payment row. Exhausted gateway-unreachable checks create `PAYMENT_REVIEW_REQUIRED`, never `PAYMENT_FAILED`.
- Chargeback and dispute callbacks create durable financial cases. Never rewrite the original order history or suspend service without an audited Ops decision.
- An older Transatel callback is ignored when it would regress an activated or terminal provider state. Wrong ICCID/subscription evidence is rejected before any lifecycle mutation.
- Replay callbacks and reconcile provisioning from the Attention queue. Every action is audited.
- `NO_REVIEW` may only be selected explicitly by Super Admin; infrastructure failure always falls back to manual review.

Monitor `/api/v1/operations/attention/platform-health` for worker heartbeats, queue age/depth, pending outbox messages, dead letters, dependencies, and open attention cases.

## Customer-support policies

- Incompatible device after successful provisioning: do not auto-refund; Ops applies the published compatibility/refund policy.
- Deleted eSIM: do not automatically create a replacement subscription or a new QR.
- Shared or compromised QR: preserve payment evidence, open a security/support case, and reconcile or suspend through audited provider actions.
- Unexpected post-activation suspension or termination: open a critical service/refund case; never rewrite payment history.

# Database deployment gate

The API startup command applies committed Prisma migrations with `prisma migrate deploy` before opening the HTTP port. This prevents a new application build from starting against an older schema. On platforms that support a dedicated pre-deploy command, prefer `pnpm db:deploy` there; the startup gate remains safe and idempotent as a fallback.

For BullMQ, configure the production Redis/Valkey instance with `noeviction`. An eviction policy such as `volatile-lru` can discard queue coordination keys and is not safe for durable job transport.
