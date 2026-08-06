# 06 — Domain Model: Orders

Primary source: `apps/api/src/modules/orders/orders.service.ts`,
`apps/api/src/modules/orders/order-machine.ts`,
`packages/shared/src/contracts.ts`, `apps/api/prisma/schema.prisma`.

## Order statuses

Shared enum `OrderStatus` (`packages/shared/src/contracts.ts:7-21`):

```
DRAFT → PAYMENT_PENDING → PAYMENT_CONFIRMED → REVIEW_PENDING
     → APPROVED → PROVISIONING → COMPLETED
     → PAYMENT_FAILED → (back to PAYMENT_PENDING | CANCELLED)
     → AWAITING_CUSTOMER (document re-upload loop)
     → PROVISIONING_FAILED → (PROVISIONING | REFUND_PENDING)
     → REFUND_PENDING → REFUNDED
     → CANCELLED (terminal)
```

The Prisma schema mirrors this enum exactly (`schema.prisma:45-59`).

## State machine

`apps/api/src/modules/orders/order-machine.ts`:

- `transitions` maps each status to its legal successors
  (`order-machine.ts:3-14`).
- `canTransition(from, to)` and `assertTransition(from, to)`; the latter
  throws `Invalid order transition: {from} -> {to}` on illegal moves
  (`order-machine.ts:15-16`).

Notable edges:
- `DRAFT → {PAYMENT_PENDING, CANCELLED}`
- `PAYMENT_PENDING → {PAYMENT_CONFIRMED, PAYMENT_FAILED, CANCELLED}`
- `PAYMENT_CONFIRMED → {APPROVED, REVIEW_PENDING}`
- `REVIEW_PENDING → {AWAITING_CUSTOMER, APPROVED, REFUND_PENDING}`
- `AWAITING_CUSTOMER → {REVIEW_PENDING, REFUND_PENDING}`
- `APPROVED → {PROVISIONING, REFUND_PENDING}`
- `PROVISIONING → {COMPLETED, PROVISIONING_FAILED}`
- `PROVISIONING_FAILED → {PROVISIONING, REFUND_PENDING}`
- `REFUND_PENDING → {REFUNDED}`
- `PAYMENT_FAILED → {PAYMENT_PENDING, CANCELLED}`
- `CANCELLED`, `COMPLETED`, `REFUNDED` are terminal.

## In-memory order shape (`DemoOrder`)

`apps/api/src/modules/orders/orders.service.ts:18-25`:

```ts
type DemoOrder = {
  id: string;
  ownerId: string | null;        // null for guest orders
  orderNumber: string;           // VC-{year}-{8 hex}
  status: OrderStatus;
  version: number;               // optimistic-lock counter
  plan: CatalogPlan;
  totalAmountNpr: number;        // plan.sellingPriceNpr at creation
  pricingSnapshot: object;       // { planId, name, amount, currency: 'NPR', topUpMobile? }
  compatibilityAcceptedAt: string;
  traveler?: TravelerInput;
  documents: { id, type, fileName, privateAssetId, status, uploadVerified? }[];
  payment?: { provider, reference, status, correlationId?, expiresAt?, returnUrl? };
  timeline: { from, to, at, reason? }[];
  qrPayload?: string;
  createdAt: string;
  providerSubscriptionId?: string;
  providerStatus?: string;
  usage?: { usedMb, totalMb, lastCheckedAt? };
  purchaseType?: 'INITIAL_PURCHASE' | 'TOPUP';
  topUpMobile?: string;
};
```

The store is an in-memory `Map<string, DemoOrder>` (`orders.service.ts:29`)
hydrated from persistence at startup (`orders.service.ts:32`).

## Order number

`VC-{UTC year}-{first 8 chars of UUID, uppercased}` (`orders.service.ts:67`).

## Creation rules (`OrdersService.create`)

`orders.service.ts:62-73`:

1. Requires `compatibilityAccepted === true` (else
   `BadRequestException` "Compatibility declaration is required").
2. Plan must exist and be active (`catalog.findActive`).
3. `purchaseType` resolved: `TOPUP` if the owner already has a completed order,
   or if `mobile` matches a completed order's traveler mobile
   (`orders.service.ts:74-93`); else `INITIAL_PURCHASE`.
4. Price is snapshotted at creation (`totalAmountNpr = plan.sellingPriceNpr`,
   `pricingSnapshot`).
5. When `ipAddress` or `userAgent` present, records an
   `E_SIM_COMPATIBILITY` consent (v1.0) (`orders.service.ts:69-71`).

## Owner identity

- Authenticated customer: `ownerId = clerkId` (`orders.controller.ts:17`).
- Guest: `ownerId = null`; persisted identity is synthesized by
  `OrdersPersistenceService.ensureIdentity` as `guest-{sha256(orderId)[0:12]}`
  with email `{suffix}@guest.visacompass.invalid`
  (`orders-persistence.service.ts:100-107`).
- Partner: `ownerId = partner:{partnerId}:{externalCustomerId}`
  (`partners.controller.ts:34`).

## Mutations and guards (service level)

- `setTraveler` — only in `DRAFT` ("Submitted order is immutable")
  (`orders.service.ts:104`).
- `addDocument` — only in `DRAFT` or `AWAITING_CUSTOMER`
  (`orders.service.ts:105`).
- `beginPayment` — requires traveler + both PASSPORT and TICKET documents
  present and verifiable; transitions to `PAYMENT_PENDING`
  (`orders.service.ts:109`).
- `cancel` — only from `DRAFT`/`PAYMENT_PENDING`/`PAYMENT_FAILED`
  (`orders.service.ts:129-136`).
- `requestRefund` — requires a COMPLETED payment and eligible status
  (`orders.service.ts:137-147`).
- `resolvePaymentFailure` — only from `PAYMENT_PENDING`/`PAYMENT_FAILED`;
  sets payment to FAILED and transitions (`orders.service.ts:120-128`).

## Redaction (least-privilege)

`OrdersService.redact` (`orders.service.ts:263-269`) strips from customer
views: `ownerId`, `providerSubscriptionId`, `providerStatus`,
`privateAssetId` per document, `correlationId` from payment, and operator
clerk ids from timeline reasons. Ops views use `expand`
(`orders.service.ts:262`), which only strips the QR payload.

## Related concepts

- Timeline events are persisted as `OrderEvent` rows and re-hydrated on load
  (`orders-persistence.service.ts:36,65-66`).
- `orderNumber` is unique in the DB (`schema.prisma:198`).
- Optimistic concurrency uses `version` (`orders-persistence.service.ts:56-57`
  throws `ConflictException` on mismatch).
