# ADR-005 — Resilient Transatel provisioning

## Status

Accepted, 2026-08-11.

## Decision

Transatel provisioning is an asynchronous saga. Provider acceptance, QR availability,
activation, and customer delivery are separate durable states recorded in
`ProvisioningOperation`.

Every logical preload uses `transatel:preload:<orderId>` as its stable idempotency key
and `orderId` as `transactionReference`. The API persists `SUBMITTING` before sending
the mutation and persists the returned provider identifiers before requesting eSIM
details. `WAITING_FOR_QR` is successful asynchronous progress and must not cause the
preload command to be replayed.

An HTTP timeout after submission is an ambiguous outcome. It transitions to
`RECONCILE_REQUIRED`; the system polls safe read endpoints and waits for signed
provider events. It never repeats the mutation unless it can prove that Transatel did
not accept it. Once the reconciliation deadline expires, the operation becomes
`MANUAL_REVIEW` and its inventory remains quarantined.

Inbound provider events use a durable inbox. HMAC verification is performed against
the exact raw request bytes. An event is acknowledged after it is durably stored;
persisted but unprocessed duplicates are re-enqueued. Processing attempts, retry time,
success, and dead-letter state are recorded independently.

## Failure handling

- Permanent input and eligibility errors are rejected without retrying the mutation.
- Authentication, rate limiting, and provider 5xx responses are classified separately.
- `Retry-After` controls the next reconciliation time for rate limiting.
- Transport ambiguity is reconciled through reads and callbacks.
- Five consecutive provider failures open an in-process circuit breaker for 30 seconds
  by default. The threshold and reset interval are configurable.
- Concurrent OAuth refreshes are coalesced into one request per API process.

## Operations

Apply migration `20260811000100_transatel_resilience` before deploying the application.
Monitor `ProvisioningOperation` rows in `RECONCILE_REQUIRED` or `MANUAL_REVIEW` and
`WebhookEvent.deadLetteredAt`. Operations can inspect the latest provisioning records at
`GET /api/v1/operations/provisioning-operations` and filter with `?state=MANUAL_REVIEW`.
Transatel webhook registration is no longer attempted at
application startup because the self-service control-plane API is deprecated; configure
the callback with Transatel operations and use the explicit admin action only for legacy
tenants.

Unassigned inventory is also reconciled through the safe eSIM-details read endpoint.
`IMPORTED`, `AVAILABLE`, and previously `QUARANTINED` profiles are checked in bounded
batches every 24 hours by default. An unassigned ICCID observed as downloaded, enabled,
installed, disabled, deleted, or released is moved to `QUARANTINED` so it cannot be sold.
Operators can trigger the same read-only check from the Inventory → Live stock tab.

Active plan balances continue to reconcile per provider subscription. Operations customer
profiles expose used, total, and remaining MB per order and provide an on-demand refresh;
stacked subscriptions are matched by provider subscription id rather than receiving an
aggregate balance.
