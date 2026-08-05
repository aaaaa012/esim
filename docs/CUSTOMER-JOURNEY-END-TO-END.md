# Customer journey — end to end (guest checkout, top-up, payment resolution, refund, plan lifecycle)

This document describes the complete purchase and lifecycle flows implemented in this
repository, including the login-free checkout path, MSISDN-based top-up, the
first-purchase vs. top-up flag, payment resolution/refund handling, and what happens
when a plan is exhausted or expires.

## 1. Entry points

| Surface        | URL                                      | Requires login |
| -------------- | ---------------------------------------- | -------------- |
| Home + catalog | `customer-web` `/`                       | No             |
| Top-up lookup  | `customer-web` `/` (top-up box)          | No             |
| Checkout       | `/esim/checkout?plan=<id>[&mobile=<msisdn>]` | **No** (guest)  |
| My eSIMs       | `/account/esims`                         | Yes            |
| Ops console    | `ops-web` `/orders`, `/admin`            | Yes (staff)    |

A guest never has to sign up. Checkout works identically for signed-in customers and
anonymous visitors; the only difference is the API surface used (see §2).

## 2. Guest (login-free) checkout

Guest orders are created without a customer, so the DB `Order.customerId` is always
filled by a deterministic **synthetic guest identity** (`guest-<sha256(orderId)>)`
that is never shown to the customer. Access is enforced with an HMAC token bound to the
order id:

```
token = HMAC-SHA256(GUEST_ORDER_SECRET, orderId)
```

- `POST /guest/orders` `{ planId, compatibilityAccepted, mobile? }` →
  `{ order, token }`. The token is kept in `sessionStorage` (`vc_guest_token`) so the
  same browser can resume an interrupted checkout.
- Every subsequent mutation is sent to `/guest/orders/:id/…` and must include the token
  (body for POST/PATCH, `?token=` query for GET). Wrong/missing tokens are rejected with
  `403`.
- Signed-in customers use the existing `/customer/orders` routes; the checkout client
  auto-detects the session via Clerk and picks the matching API surface.

Guest checkout runs the full compliance flow: compatibility declaration → traveller
details → passport/ticket upload → payment. Provisioning and QR delivery are identical
to the signed-in path.

## 3. Top-up by MSISDN

Top-up means: the customer already has an activated eSIM for a given mobile number and
buys a new plan for it.

- The **home page** has a "top-up box" (`topup-lookup.tsx`). Entering a number calls
  `POST /guest/orders/topup-lookup` `{ mobile }` (public).
- The backend normalizes the number (strips `+977`, leading `0`, spaces/dashes) and
  searches completed orders by traveller `mobile` — first the in-memory set, then
  (when Prisma is enabled) completed orders.
- On a match it returns the subscriber's current plan, expiry, and usage, and the box
  stores the number in `sessionStorage` (`vc_topup_mobile`). Plan cards then render
  "Recharge" instead of "Choose" and append `&mobile=…` to the checkout URL.
- Checkout passes `mobile` to order creation, and the backend detects the existing
  subscription to set the order type (see §4).

## 4. First purchase vs. top-up flag

The order type is derived at order creation and persisted:

- `INITIAL_PURCHASE` when no prior completed order exists for the owner **or** the
  provided mobile.
- `TOPUP` when the signed-in owner already has a completed order, or a completed order
  exists for the supplied mobile.

Implementation:
- In-memory `DemoOrder.purchaseType` and `topUpMobile`.
- Persisted to the DB `Order.orderType` enum (already present in the schema) and the
  `topUpMobile` hint is stored inside `pricingSnapshot`.
- The flag is **surfaced to ops**: a `FIRST PURCHASE` / `TOP-UP` pill in the order list
  and order review, plus the top-up target number on the review page.

## 5. Payment resolution (no more stuck orders)

Every payment carries an `expiresAt` window from the gateway. Four states are
resolvable:

| Situation                          | Endpoint (customer)                    | Endpoint (guest)                       | Endpoint (ops)                          |
| ---------------------------------- | -------------------------------------- | -------------------------------------- | --------------------------------------- |
| Payment window expired             | — (automatic)                          | — (automatic)                          | `POST /operations/payments/expire-stale`|
| Customer abandons payment          | `POST /customer/orders/:id/payment/abandon` | `POST /guest/orders/:id/payment/abandon` | `POST /operations/orders/:id/payment/fail` |
| Customer cancels a draft/retry     | `PATCH /customer/orders/:id/cancel`    | `POST /guest/orders/:id/cancel`        | `POST /operations/orders/:id/cancel`    |
| Payment confirmed but order fails  | —                                      | —                                      | Refund flow (§6)                        |

- `OrdersService.expireStalePayments()` moves `PAYMENT_PENDING` orders whose
  `expiresAt` has passed to `PAYMENT_FAILED` (`PaymentStatus.FAILED`).
- `resolvePaymentFailure` is idempotent: it never regresses an order that already moved
  past `PAYMENT_PENDING` (i.e. a late failure after the money actually landed is
  handled via refund, not by flipping the order back).
- The ops console has a "Expire stale payments" control and per-order fail/cancel.

## 6. Refunds

- Any order that was paid (`PaymentStatus.COMPLETED`) and is past `PAYMENT_PENDING`
  can be refunded.
- Ops: `POST /operations/orders/:id/payment/refund` `{ reason }` →
  `OrdersService.requestRefund` transitions the order to `REFUND_PENDING`, then
  `PaymentsService.refund` calls the gateway's `refund()` and
  `OrdersService.markRefunded` transitions to `REFUNDED`.
- Gateways: the simulator fully implements refunds; Khalti uses
  `POST /epayment/refund/`; eSewa refunds are flagged as manual (merchant console).
- The order review page shows a "Refund order" button whenever a refund is possible.

## 7. Plan expiry / exhaustion lifecycle

`ReconciliationService.run()` (every `RECONCILIATION_INTERVAL_MINUTES`, default 15) now
also runs `sweepLifecycle()`:

- Subscriptions whose inventory `expiresAt` has elapsed are marked `EXPIRED`
  (subscription + inventory) and the subscriber is emailed `PLAN_EXPIRED`.
- Subscriptions whose `usedMb >= totalMb` are marked `EXPIRED` and emailed
  `PLAN_EXHAUSTED`.
- Notifications are enqueued only when the order has a traveller email; failures are
  logged, never fatal.

Both templates exist in `notification.templates.ts` and point the customer back to
the top-up flow.

## 8. Backend API surface (new/changed)

| Route | Auth | Purpose |
| ----- | ---- | ------- |
| `POST /guest/orders` | none | create order, returns `{ order, token }` |
| `GET /guest/orders/:id` | token | resume order |
| `PATCH /guest/orders/:id/traveler` | token | traveller details |
| `POST /guest/orders/:id/documents` | token | upload authorization |
| `POST /guest/orders/:id/documents/:documentId/confirm` | token | confirm upload |
| `POST /guest/orders/:id/payment` | token | initiate payment |
| `POST /guest/orders/:id/payment/verify` | token | confirm payment |
| `POST /guest/orders/:id/payment/simulate` | token | dev-only simulation |
| `POST /guest/orders/:id/payment/abandon` | token | resolve failure |
| `POST /guest/orders/:id/cancel` | token | cancel draft |
| `POST /guest/orders/topup-lookup` | none | MSISDN → current plan |
| `GET /operations/topup/lookup?mobile=` | staff | ops MSISDN lookup |
| `POST /operations/orders/:id/payment/refund` | staff | refund paid order |
| `POST /operations/orders/:id/payment/fail` | staff | resolve failed payment |
| `POST /operations/orders/:id/cancel` | staff | cancel order |
| `POST /operations/payments/expire-stale` | staff | sweep expired windows |
| `PATCH /customer/orders/:id/cancel` | customer | cancel own order |
| `POST /customer/orders/:id/payment/abandon` | customer | resolve own failure |

Changed: `GET /partners/orders/:id/usage` now resolves usage by the assigned **ICCID**
(not the order id), so partner usage is accurate for provisioned eSIMs.

## 9. Configuration

- `GUEST_ORDER_SECRET` — HMAC secret for guest order tokens (see `.env.example`).
- `RECONCILIATION_INTERVAL_MINUTES` — lifecycle sweep cadence.

## 10. Verification

- `pnpm --filter @visa-compass/api typecheck && pnpm --filter @visa-compass/api test`
- `pnpm --filter @visa-compass/customer-web typecheck`
- `pnpm --filter @visa-compass/ops-web typecheck`

Manual smoke path (dev, `PAYMENT_MODE=simulator`):
1. As a guest (not signed in): open `/`, pick a plan, go through compatibility →
   traveller → documents → payment → "Simulate verified payment" → success panel.
2. Repeat as a guest but complete the order (QR "emailed"), then open `/`, enter the
   mobile used in the traveller step → the top-up box shows the current plan and plan
   cards become "Recharge".
3. In ops: the completed order shows a `FIRST PURCHASE` pill; the recharge order shows
   `TOP-UP` and the top-up target number. Use "Refund order" on a paid order and confirm
   it reaches `REFUNDED`.
4. In ops System Config, "Look up a subscriber by MSISDN" and "Expire stale payments".
