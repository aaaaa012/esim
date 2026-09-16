# 08 — Payments

Primary sources: `apps/api/src/modules/payments/payments.service.ts`,
`apps/api/src/modules/payments/payment-gateway.ts`,
`apps/api/src/modules/payments/gateways/{simulator,khalti,fonepay}.gateway.ts`.

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

`PaymentProvider` enum: `KHALTI`, `FONEPAY`
(`packages/shared/src/contracts.ts:23`).
`PaymentStatus` enum: `INITIATED | PENDING | COMPLETED | FAILED | CANCELLED | REFUNDED`
(`contracts.ts:24`).

## Gateway selection

`PaymentsService.gateway` (`payments.service.ts:25`):

- If `PAYMENT_MODE === 'sandbox'` or `NODE_ENV === 'production'` → the real
  gateway for the requested provider (Khalti or Fonepay).
- Otherwise → `PaymentSimulatorGateway` regardless of the requested provider.

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
- Refunds use the intentional dual-control manual-refund workflow for both
  Khalti and Fonepay. No adapter sends refund money automatically. Operations
  requests the refund, a Super Admin approves it, staff completes it in the
  original provider, and a Super Admin records the exact amount, completion
  time and unique provider reference before local payment/order state changes.
- `simulate(orderId, ownerId, reference, scenario='SUCCESS')`
  (`payments.service.ts:23`):
  - Disabled in production.
  - `TIMEOUT` scenario throws immediately.
  - Applies the scenario to the simulator then verifies like a normal payment.

## Client telemetry

`PaymentsService.reportTelemetry` (`payments.service.ts:150`) accepts
structured Fonepay frontend events (QR_RENDERED, BANK_LAUNCHED, PAYMENT_RESULT,
socket lifecycle events, errors) and persists them against the payment's
reference for observability.

`redactFonepayLaunchUrl` (`payments.service.ts:28`) strips the full
`qrPayload` value from the reported `launchUrl` before persistence so raw QR
data is never stored in server logs or the payments table.

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
- Automated refunds are intentionally outside `KhaltiGateway`. The shared
  manual-refund workflow records completion only after staff performs and
  verifies the refund in Khalti.

## Fonepay gateway

`fonepay.gateway.ts` implements the supplied Checkout by Fonepay v1.10
contract: signed OAuth login, issuer bank list, single-use Intent QR creation,
WebSocket notification, and authoritative server-side status lookup. The
WebSocket never confirms payment by itself; it only prompts a signed backend
lookup. The adapter checks the PRN, terminal, requested amount, total
transaction amount, trace ID and documented status before payment completion.
A `success` status requires a non-empty `fonepayTraceId` (for reconciliation
and refund evidence), a `requestedAmount` equal to the order amount, and a
`totalTransactionAmount` equal to `requestedAmount` when the provider returns
it. Reference labels are generated at 25 characters total (V1.10 documents 30;
live support enforces 25) and validated as alphanumeric-only per V1.10 §9.4/
§9.6. Automated refunds are intentionally outside
the adapter and use the same manual-refund workflow as Khalti.

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
