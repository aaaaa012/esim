# Recharge ownership and recovery rollout

## Behavior

A customer-web recharge belongs to the original initial-purchase order's current customer. Its authenticated purchaser is recorded separately; anonymous recharge creates no user/customer. The emailed authorization binds inventory, original order, customer and recovery recipient for 15 minutes. Lookup always starts from the initial purchase, so a later completed recharge cannot hide the subscriber.

The recharge order, hashed email-recovery credential, and encrypted notification payload are persisted in one transaction. Worker outages leave a durable notification for reconciliation. Session credentials last 24 hours; recovery links last 30 days. Reissue rotates recovery credentials and the delivery payload. Credentials are never returned in customer/ops notification listings.

`POST /recharges` accepts `planId`, `termsAccepted`, `privacyAccepted`, `checkoutAttemptKey`, and exactly one of `lookupToken` or `targetEsimId`. Signed-in identity is optional; a supplied invalid login is rejected. An owned-eSIM selection requires the beneficiary's account. The attempt key is unique and the normalized request hash prevents changed-input replay. Generic API idempotency response caching is not used for recharge credentials; authorization is rechecked on every request.

`GET /recharges/:id`, `POST /recharges/:id/payment/initiate`, `/payment/verify`, and `/recover` expose only the individual transaction. `POST /recharges/recovery-link` accepts order number and recovery email, is rate limited, returns a generic response, and rotates links on a match. `GET /recharges/purchases` includes owned orders and transactions initiated by the authenticated purchaser. eSIM inventory access remains beneficiary-only. Recharge orders cannot be claimed to transfer ownership.

Partner API and partner-hosted top-ups use the same purchaser/beneficiary separation. `externalCustomerId` records the partner's purchaser, while the resolved completed order supplies the immutable beneficiary `customerId` and `targetInventoryId`. Cross-channel top-ups are allowed, but they do not grant the partner activation-detail, usage, or lifecycle-management access to an eSIM that the partner did not originally supply.

## Deployment sequence

1. Back up the hosted PostgreSQL database using the existing operations procedure.
2. Apply `20260904150000_recharge_ownership` before starting the updated API or workflow workers. It adds nullable order relations, unique checkout-attempt keys, and encrypted recovery notification fields. Do not drop these fields on rollback.
3. Deploy the API and workflow workers together, then customer-web and ops-web. Configure the same existing encryption and session-signing secrets on all API/worker replicas. The implementation uses the existing queue, notification and reconciliation services.
4. Existing mobile-only lookup links must be requested again; they have a 15-minute lifetime. Existing order-specific recovery tokens still work. Updated checkout recognizes existing recharge order URLs and uses the scoped recharge endpoints. In-flight legacy clients should reload before further recharge actions.
5. Review the historical dry-run report before applying any repairs. Do not run repair against a database that has not received the migration.

## Historical repair

Run from `apps/api` against the explicitly selected hosted environment:

```sh
pnpm db:reconcile-recharges > recharge-review.json
pnpm db:reconcile-recharges --apply --review recharge-review.json
```

The default command only reads. The apply command accepts only unchanged `REPAIR` decisions from the reviewed report; it rechecks each decision in a transaction and records an audit event. `REVIEW` rows require manual investigation. Rerunning after repair is safe. It does not modify payment references, provider subscriptions, user/customer accounts, or consent history. Existing authenticated purchase attribution is retained when supported by the old order's identity. Guest purchasers remain anonymous. Original initial-purchase account claims determine the current beneficiary, not stale assignment customer IDs or matching email addresses.

Do not merge or delete old guest accounts as part of this repair. Refresh API replicas after repair if an existing process holds old owner-keyed order caches.

## Hosted smoke test

Use designated test accounts, an existing test eSIM, and the approved payment/provider test configuration; isolated unit tests do not validate live provider behavior.

- Recharge through the original-email link as guest, owner, and a different account. Confirm one beneficiary customer, recorded purchaser when authenticated, same inventory, separate subscription.
- Confirm the different purchaser can buy a new initial eSIM and cannot fetch the beneficiary's QR, profile, documents, or other orders.
- Close checkout before payment, recover through email, retry a failed payment, and verify a late/duplicate callback only advances fulfillment once.
- Simulate worker/queue disruption in the test environment: verify the durable recovery email is retried and the tracked order remains the same.
- Check payment uncertainty and provider uncertainty stay pending/reviewable without collecting again or blindly resubmitting a subscription.
- Reissue recovery links, verify previous recovery links fail, and inspect pending/completed refund status from the scoped tracking page.
- Compare ops customer history with physical eSIM packages, check the purchaser label, and verify partner API attribution remains unchanged.

## Monitoring and rollback

Watch recharge checkout-replay logs, denied access logs, beneficiary mismatch logs, notification failures/retry age, existing payment review cases, and paid provisioning cases awaiting confirmation. Never include bearer links or owner contact details in logs.

If a hosted smoke test fails, stop new recharge intake and fix or roll back the frontend/API release as appropriate. Keep the additive columns, recovery credentials, transaction records, and audits. Do not revert repaired beneficiary data by deleting records. An old API does not understand purchaser access; retain the updated tracking API when rolling back only the UI.
