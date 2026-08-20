# 08 — Payments

Primary sources: `apps/api/src/modules/payments/payments.service.ts`,
`apps/api/src/modules/payments/payment-gateway.ts`,
`apps/api/src/modules/payments/gateways/{simulator,khalti}.gateway.ts`.

## Gateway contract

`payment-gateway.ts`:

```ts
interface PaymentGateway {
  readonly provider: string;
  initiate(input: {
    orderId;
    orderNumber;
    amountNpr;
    returnUrl;
  }): Promise<PaymentInitiation>;
  verify(reference, context: PaymentContext): Promise<PaymentVerification>;
  refund?(reference, context, amountNpr): Promise<{ reference }>;
}
type PaymentInitiation = { reference; redirectUrl; expiresAt; correlationId? };
type PaymentVerification = {
  reference;
  providerTransactionId?;
  status;
  amountNpr;
  orderId;
};
type PaymentContext = { orderId; amountNpr; correlationId? };
```

`PaymentProvider` enum: `KHALTI` (`packages/shared/src/contracts.ts:23`).
`PaymentStatus` enum: `INITIATED | PENDING | COMPLETED | FAILED | CANCELLED | REFUNDED`
(`contracts.ts:24`).

## Gateway selection

`PaymentsService.gateway` (`payments.service.ts:25`):

- If `PAYMENT_MODE === 'sandbox'` or `NODE_ENV === 'production'` → the real
  Khalti gateway.
- Otherwise → `PaymentSimulatorGateway`.

Note: `PAYMENT_MODE === 'sandbox'` routes to real gateways; a simulator mode
string is not required. When `NODE_ENV=production`, the simulator is rejected
for `simulate` calls (`payments.service.ts:23`).

## Orchestration (`PaymentsService`)

- `initiate(orderId, ownerId, provider)` (`payments.service.ts:11`):
  - returnUrl = `{CUSTOMER_WEB_URL}/esim/checkout?orderId={orderId}`.
  - Calls `gateway.initiate`.
  - Calls `OrdersService.beginPayment` (requires traveler + 2 docs, moves to
    `PAYMENT_PENDING`).
- `verify(orderId, ownerId, reference)` (`payments.service.ts:12`):
  - Looks up the order, builds context from `order.payment.reference` and
    `correlationId`.
  - Gateway verify must return COMPLETED, matching orderId and matching
    `amountNpr`; otherwise `BadRequestException` "Payment lookup did not
    confirm the order".
  - On success → `OrdersService.confirmPayment` (auto-approves).
- `verifyCallback(orderId, reference)` (`payments.service.ts:13`): same but
  used by the payment webhook worker (skips ownership check, already completed
  short-circuit).
- `refund(orderId, actorId, reason)` (`payments.service.ts:14-22`):
  - `requestRefund` → `gateway.refund` (Khalti supports) → `markRefunded`.
- `simulate(orderId, ownerId, reference, scenario='SUCCESS')`
  (`payments.service.ts:23`):
  - Disabled in production.
  - `TIMEOUT` scenario throws immediately.
  - Applies the scenario to the simulator then verifies like a normal payment.

## Simulator gateway

`simulator.gateway.ts`:

- In-memory `Map<reference, { orderId, amountNpr, status }>`.
- `initiate` returns a `redirectUrl` = returnUrl + `?simulated=1&reference=...`,
  `expiresAt` = now + 30 min.
- `complete(reference)` marks COMPLETED.
- `apply(reference, scenario)` mutates status; `WRONG_AMOUNT` sets COMPLETED
  but bumps amount by 1 so verification fails — useful for testing the amount
  guard (`simulator.gateway.ts:12`).
- `sign(payload)` = HMAC-SHA256 with `PAYMENT_SIMULATOR_SECRET`
  (default `local-development-only-change-me`).
- `verify` returns the stored record (or a PENDING synthetic one) with
  `providerTransactionId = sim-{reference}`.
- `refund` marks REFUNDED and returns `refund-{reference}`.

## Khalti gateway

`khalti.gateway.ts`:

- Requires `KHALTI_SECRET_KEY`; else throws `ApiException`
  `PAYMENT_PROVIDER_ERROR` (503). Every request uses a 15 s timeout
  (`KHALTI_REQUEST_TIMEOUT_MS`).
- `initiate` → `POST {KHALTI_BASE_URL}/epayment/initiate/` with
  `Authorization: Key {KHALTI_SECRET_KEY}`; amount in paisa
  (`amount * 100`); body includes `return_url`, `website_url` (origin of
  return URL), `purchase_order_id`, `purchase_order_name`. Returns `{ pidx,
payment_url, expires_at }` → mapped to `{ reference: pidx, redirectUrl,
expiresAt }`.
- `verify` → `POST .../epayment/lookup/` with `{ pidx }`; maps status strings
  case-insensitively: Completed→COMPLETED, Pending/Initiated→PENDING,
  Refunded/Partially Refunded→REFUNDED, Expired→FAILED, "User canceled"→CANCELLED;
  amount `total_amount / 100`; the response `transaction_id` is persisted as
  the payment's `providerTransactionId` on confirmation.
- `refund` → Khalti Refund API
  `POST {origin}/api/merchant-transaction/{transaction_id}/refund/` (base is
  `KHALTI_BASE_URL` minus the `/v2` suffix; `transaction_id` is the lookup
  `transaction_id`, not the pidx). Wallet full refund sends an empty body;
  a partial refund sends `{ amount }` (paisa). Returns
  `refund-{transaction_id}` as the internal refund reference.

**Error handling** (`khalti.gateway.ts:32-69`): provider failures are thrown
as `ApiException` with code `PAYMENT_PROVIDER_ERROR` (502). The provider's
`detail` / `error_key` / per-field validation messages and the HTTP status are
kept in `details` (logged server-side, never serialized to clients).

- Initiate: any non-2xx (401 invalid token, 400 `validation_error`, 404) → `PAYMENT_PROVIDER_ERROR` with the parsed error detail; a 2xx body
  missing `pidx`/`payment_url` is also rejected as `PAYMENT_PROVIDER_ERROR`.
- Verify: the body `status` is mapped before any HTTP-status check, so the
  400 outcomes Khalti returns for `Expired` / `User canceled` still resolve to
  FAILED / CANCELLED rather than surfacing as provider errors; a non-2xx
  without a body `status` (e.g. 401 invalid token, 404 unknown `pidx`) →
  `PAYMENT_PROVIDER_ERROR`; a 2xx body without `status` is likewise rejected.
- Refund: non-2xx → `PAYMENT_PROVIDER_ERROR` with parsed detail.
- Transport failures (network down, DNS, request timeout) thrown by `fetch`
  are caught by `request()` and rethrown as `PAYMENT_PROVIDER_ERROR` (502) so
  a provider outage surfaces with the correct payment error code instead of a
  generic 500. The underlying message is kept in `details`, server-side only.

## Verification invariants

`PaymentsService.verify`/`verifyCallback` require all three to hold
(`payments.service.ts:12-13`):

1. `result.status === COMPLETED`
2. `result.orderId === order.id`
3. `result.amountNpr === order.totalAmountNpr`

The checkout UI surfaces this as "The server checks the exact order, reference
and immutable NPR amount" (`checkout-client.tsx:670-673`).

## Persistence

Payments are persisted by `OrdersPersistenceService.save` as a `Payment` row
keyed by unique `paymentReference`, with correlation id, expiry, returnUrl,
and `paidAt` set when completed (`orders-persistence.service.ts:64`).

## Webhook → verification bridge

`IntegrationProcessor.payment` (`integration.processor.ts:25`) reads the
webhook payload for `orderId` and `reference`, then calls
`payments.verifyCallback`. Failure marks the webhook event with the error
message.
