# 12 — Background Jobs

Primary sources: `apps/api/src/jobs/queues.ts`, `queue.service.ts`,
`provisioning.processor.ts`, `integration.processor.ts`,
`reconciliation.service.ts`. Design intent: `docs/ADR-004-jobs.md`.

## Queues

`queues.ts`:

```ts
export const QUEUES = {
  provisioning: "provisioning",
  providerCallbacks: "provider-callbacks",
  payments: "payments",
  notifications: "notifications",
  reconciliation: "reconciliation",
};

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: 500,
  removeOnFail: 2_000,
};
```

## QueueService

`queue.service.ts`:

- `enabled = Boolean(process.env.REDIS_URL)` (`queue.service.ts:14`).
- `add(name, jobName, payload, jobId)` (`queue.service.ts:16-24`):
  - Without Redis: logs and returns `{ id: jobId, simulated: true }` — no
    worker runs; callers fall back to in-process execution.
  - With Redis: `queue.add(jobName, payload, { ...DEFAULT_JOB_OPTIONS, jobId })`.
- `registerWorker(name, processor)` (`queue.service.ts:26-32`): creates a
  BullMQ `Worker` with concurrency from `QUEUE_CONCURRENCY` (default 3); logs
  failed jobs. Idempotent per queue name.
- `onModuleDestroy` closes queues/workers/connection.

## Provisioning worker

`provisioning.processor.ts:10`:

- Registers the `provisioning` queue.
- Job `provision-order` → `orders.processProvisioning(orderId,
job.attemptsMade + 1, final = (attemptsMade + 1 >= 3))`.
- Max attempts per job = 3 (from `DEFAULT_JOB_OPTIONS`).

## Integration worker

`integration.processor.ts:20`:

- Registers `notifications`, `payments`, and `providerCallbacks` queues.
- `notification(job)` (`integration.processor.ts:23-24`): marks SENDING,
  renders template, EMAIL via Gmail (+ optional QR PDF attachment for
  QR_READY), WHATSAPP via WhatsApp channel, then marks SENT/SIMULATED/FAILED.
- `payment(job)` (`integration.processor.ts:25`): loads payload (inline or
  from `WebhookEvent`), requires `orderId` + `reference`, calls
  `payments.verifyCallback`, marks the webhook event processed.
- `connectivity(job)` (`integration.processor.ts:26`): loads payload, calls
  `connectivityService.handleWebhook`; if handled with an event, calls
  `orders.applyProviderEvent(event)`; marks processed. If not handled, marks
  processed and returns `{ accepted: true, skipped: true, reason }`.
- `complete(job, error?)` marks `processedAt` and optional `errorMessage`
  (`integration.processor.ts:22`).

## Reconciliation worker

`reconciliation.service.ts`:

- `onModuleInit` (`reconciliation.service.ts:28-36`): registers the
  `reconciliation` queue worker; starts a `setInterval` of
  `RECONCILIATION_INTERVAL_MINUTES` (default 15 min); runs once immediately.
- `run()` (`reconciliation.service.ts:42-73`): requires Prisma; first
  `sweepLifecycle`, then finds up to 500 ACTIVE subscriptions whose
  `usageLastCheckedAt` is stale (older than the interval) and enqueues
  `reconcile-usage` per subscription (or runs synchronously when queues are
  disabled).
- `sweepLifecycle()` (`reconciliation.service.ts:75-95`): scans up to 500
  ACTIVE subscriptions; if `expiresAt` elapsed or `usedMb >= totalMb`,
  marks the subscription and inventory `EXPIRED` and emails the customer
  (`PLAN_EXPIRED` / `PLAN_EXHAUSTED`).
- `reconcile(subscriptionId)` (`reconciliation.service.ts:106-122`): polls
  `connectivity.getUsage(iccid)` and persists fresh usage.

## In-process fallback chain

When `REDIS_URL` is unset, the following services execute the work directly:

- Provisioning: `OrdersService.processLocally` retries up to 3 attempts
  (`orders.service.ts:259`).
- Notifications: `NotificationService.enqueue` marks SENT immediately
  (`notification.service.ts:14`).
- Reconciliation: jobs run synchronously in the loop
  (`reconciliation.service.ts:70`).

## Webhook persistence interplay

`WebhooksController` enqueues:

- `payments` → `payment-callback` (`webhooks.controller.ts:43`)
- `providerCallbacks` → `connectivity-callback` (`webhooks.controller.ts:60`)
- The webhook `WebhookEvent` row is persisted first, so the worker can reload
  the payload if the job didn't carry it (`integration.processor.ts:21`).
