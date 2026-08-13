# Transatel operations runbook

## Healthy state

- Connectivity shows **Connected**, authenticated **Yes**, and circuit **Closed**.
- Diagnostics show recent successful token, catalog, eSIM details, usage, and provisioning calls when those workflows have run.
- Webhook target and secret are configured, events are arriving, and dead letters remain zero.

## Safe checks

1. Run **Diagnostics**. This reads provider and local telemetry; it does not provision or modify a subscriber.
2. On an assigned eSIM, use **Check live** to fetch the provider state and reconcile local status.
3. Use Provider Logs and the correlation ID to investigate a failed call.

## Mutating staging smoke test

Only use an eSIM explicitly designated through `TRANSATEL_TEST_ESIM_ICCID`; never use a customer subscription. Purchase and provision the test plan, verify QR delivery and usage, suspend it, reconcile until suspended, then terminate as Super Admin and reconcile until terminated. Record the order and provider references in the release evidence.

## Recovery

- Open circuit: wait for the configured cooldown, correct credentials/network access, then rerun diagnostics.
- Accepted or uncertain lifecycle action: do not resubmit; use **Check live** until provider status confirms it.
- Webhook dead letter: inspect Events, correct the processing error, and use the existing retry flow.
- Stale usage: run Refresh Usage; if it fails, inspect the latest `usage` provider log.
