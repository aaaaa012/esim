# 07 — Order Lifecycle Flows

This document walks the main end-to-end flows as implemented. Endpoints are
listed in `docs/04-api-surface.md`; the state machine is in
`docs/06-domain-model-orders.md`.

## 1. Authenticated customer purchase flow

Routes: `OrdersController` (`orders.controller.ts:10-23`), `PaymentsController`
(`payments.controller.ts:7-15`), `NotificationController`
(`notification.controller.ts:12-13`).

1. **Create**: `POST /customer/orders` with `{ planId, compatibilityAccepted: true }`.
   → `OrdersService.create` builds a `DRAFT` order, snapshots price, resolves
   purchase type, records consent if headers present
   (`orders.service.ts:62-73`).
2. **Traveler**: `PATCH /customer/orders/:id/traveler` — only while `DRAFT`
   (`orders.service.ts:104`).
3. **Documents**: `POST /customer/orders/:id/documents` returns a signed upload
   authorization; client uploads to Cloudinary (or simulator) then
   `POST .../documents/:documentId/confirm` verifies it
   (`orders.service.ts:105-106`; see `docs/14-document-storage.md`).
4. **Payment**: `POST /customer/orders/:id/payment` → `PaymentsService.initiate`
   → gateway initiation → `OrdersService.beginPayment` moves to
   `PAYMENT_PENDING`, requiring traveler + PASSPORT + TICKET
   (`payments.service.ts:11`, `orders.service.ts:109`).
5. **Verify**: `POST .../payment/verify` or gateway callback
   (`PaymentsService.verify` / `verifyCallback`) → `confirmPayment`
   (`payments.service.ts:12-13`, `orders.service.ts:110-119`).
   `confirmPayment` sets payment COMPLETED, moves to `PAYMENT_CONFIRMED`, then
   auto-approves: `autoApprove` transitions `APPROVED → PROVISIONING` and
   enqueues provisioning (`orders.service.ts:116,257`).
6. **Provisioning**: `ProvisioningProcessor` → `OrdersService.processProvisioning`
   → Transatel → on success assigns inventory, transitions to `COMPLETED`,
   enqueues `QR_READY` email (`orders.service.ts:215`,
   `provisioning.processor.ts:10`).
7. **Notification**: QR email with unencrypted PNG attachment
   (`integration.processor.ts:23-24`, `docs/11-notifications.md`).

## 2. Guest checkout flow

Routes: `GuestOrdersController` (`guest-orders.controller.ts:12-61`). No Clerk
auth; every mutation requires the HMAC `token`.

1. `POST /guest/orders` with `{ planId, compatibilityAccepted: true, mobile?, email? }`
   → returns `{ order, token }` (`guest-orders.controller.ts:16-32`).
2. Token is stored client-side (`sessionStorage["vc_guest_token"]`) and sent
   on every subsequent call (`checkout-client.tsx:96-118,244-248`).
3. Same traveler → documents → payment steps via `/guest/orders/...` paths.
4. Payment simulate: `POST /guest/orders/:id/payment/simulate`
   (`guest-orders.controller.ts:46`).
5. `POST /guest/orders/:id/cancel`, `/payment/abandon` for failures
   (`guest-orders.controller.ts:48-50`).

Guest order persistence synthesizes a `guest-*` user/customer
(`orders-persistence.service.ts:100-107`).

## 3. Document review flow (Operations)

Routes: `OperationsController` (`orders.controller.ts:25-49`).

1. After payment, orders land in `PAYMENT_CONFIRMED` → auto-approve normally
   bypasses review; but `PAYMENT_CONFIRMED` may also go to `REVIEW_PENDING`
   (`order-machine.ts:6`).
2. `POST /operations/orders/:id/documents/:documentId/approve` sets document
   `APPROVED` and records a timeline event (`orders.service.ts:213`).
3. `POST /operations/orders/:id/documents/:documentId/request-reupload` sets
   document `REUPLOAD_REQUIRED`, moves the order to `AWAITING_CUSTOMER`,
   records an `OrderReview` and audit log (`orders.service.ts:213`,
   `orders-persistence.service.ts:86-94`).
4. `POST /operations/orders/:id/request-reupload` marks **all** documents
   `REUPLOAD_REQUIRED` and moves to `AWAITING_CUSTOMER`
   (`orders.service.ts:212`).
5. Customer re-uploads; `confirmDocument` moves `AWAITING_CUSTOMER` →
   `REVIEW_PENDING` when no doc is `REUPLOAD_REQUIRED`
   (`orders.service.ts:106`).
6. `POST /operations/orders/:id/approve` requires both PASSPORT and TICKET to
   be `APPROVED`, then reserves inventory and starts provisioning
   (`orders.service.ts:214`).

## 4. Provisioning flow

1. `OrdersService.approve` → `inventory.reserve` → transitions to `APPROVED`
   then `PROVISIONING` → enqueues `provisioning:provision-order`
   (`orders.service.ts:214`).
2. `ProvisioningProcessor` runs `processProvisioning(orderId, attempt, final)`
   (`provisioning.processor.ts:10`). Max 3 attempts via BullMQ job options
   (`queues.ts:9-14`).
3. `processProvisioning` (`orders.service.ts:215`):
   - Resolves inventory profile.
   - Calls `connectivity.provision`.
   - Persists a `ProvisioningAttempt` (request + response snapshot).
   - Requires `qrPayload` in the result; otherwise throws.
   - Assigns inventory to the customer (`inventory.assign`).
   - Transitions to `COMPLETED`, enqueues `QR_READY` notification.
   - On error: records attempt; if final attempt, transitions to
     `PROVISIONING_FAILED` and rethrows.
4. Without Redis, `processLocally` retries in-process up to 3 times
   (`orders.service.ts:259`).
5. `POST /operations/orders/:id/retry` re-enters provisioning after
   `PROVISIONING_FAILED` (`orders.service.ts:256-258`).

### Activation via provider callback

`applyProviderEvent` (`orders.service.ts:223-255`): when a provider event
reports `status: 'ACTIVATED'` while the order is `PROVISIONING`, it takes the
QR payload (from event or stored), assigns inventory, applies lifecycle,
transitions to `COMPLETED`, and enqueues `QR_READY`
(`orders.service.ts:236-248`). Otherwise it applies lifecycle and persists.

## 5. Payment failure / abandon / expiry

- `POST /customer/orders/:id/payment/abandon` and
  `POST /operations/orders/:id/payment/fail` → `resolvePaymentFailure`
  (`orders.service.ts:120-128`).
- `POST /operations/payments/expire-stale` → `expireStalePayments`: any
  `PAYMENT_PENDING` order whose `payment.expiresAt` has passed becomes
  `PAYMENT_FAILED` with reason `Payment window expired`
  (`orders.service.ts:155-167`).

## 6. Refund flow

`POST /operations/orders/:id/payment/refund` → `PaymentsService.refund`
(`payments.service.ts:14-22`):

1. `OrdersService.requestRefund` transitions to `REFUND_PENDING`
   (`orders.service.ts:137-147`).
2. Gateway `refund()` is invoked (Khalti).
3. `OrdersService.markRefunded` transitions to `REFUNDED`
   (`orders.service.ts:148-154`).

## 7. Partner flow

Routes: `PartnersController` (`partners.controller.ts:16-56`). Partner orders
are namespaced by `partner:{id}:{externalCustomerId}` and verified in
`partnerOrder()` (`partners.controller.ts:55`). The flow mirrors the customer
flow (create → traveler → documents → payments) but through `/partners`
routes. Partners can also quote, check connectivity health, fetch usage, and
trigger notifications.

## 8. Top-up lookup

- Customer portal widget calls `POST /guest/orders/topup-lookup`
  (`topup-lookup.tsx:32`).
- `OrdersService.topUpLookup` normalizes mobile numbers (strips spaces/dashes,
  optional `+977`/`0` prefix) and matches a completed order whose traveler
  mobile normalizes equal (`orders.service.ts:168-196`).
- A matching completed order with a QR payload returns `topUpAvailable: true`
  and stores `vc_topup_mobile` in session storage
  (`topup-lookup.tsx:41-46`).
- The checkout then carries `mobile` to create the new order as a `TOPUP`
  (`orders.service.ts:74-85`, `checkout-client.tsx:235-249`).

## 9. Lifecycle expiry / exhaustion

`ReconciliationService.sweepLifecycle`
(`reconciliation.service.ts:75-95`): active subscriptions that are past
`expiresAt` or fully consumed are marked `EXPIRED` and the customer is emailed
`PLAN_EXPIRED` or `PLAN_EXHAUSTED` respectively.
