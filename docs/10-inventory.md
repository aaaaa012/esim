# 10 — Inventory (eSIM)

Primary source: `apps/api/src/modules/inventory/inventory.service.ts`,
`apps/api/src/modules/inventory/inventory.controller.ts`,
`apps/api/prisma/schema.prisma` (models `EsimInventory`, `InventoryBatch`,
`CustomerEsim`, `Subscription`).

## Status lifecycle

`InventoryStatus` enum (`schema.prisma:83-91`, mirrored in
`packages/shared/src/contracts.ts:27`):

```
IMPORTED → AVAILABLE → RESERVED → ASSIGNED → ACTIVATED
                                        ↘ EXPIRED → TERMINATED
```

## Core operations

### Seeding (`onModuleInit`, `inventory.service.ts:13-18`)

- Only when Prisma is enabled **and** `NODE_ENV !== 'production'` **and** the
  inventory table is empty.
- Creates one batch `DEV-MOCK-{year}` with 20 profiles:
  - `iccid = 899770100000000{000..019}`
  - `eid = 890490320000000000000000000{000..019}`
  - `activationCodeEncrypted` = encrypted `LPA:1$mock.smdp.visacompass.local${batchId}-{i}`
  - `smDpAddress = mock.smdp.visacompass.local`
  - status `AVAILABLE`.

### Reservation (`reserve`, `inventory.service.ts:20-31`)

- In-memory mode returns `{ id: memory-{orderId}, eid: mock-{orderId}, iccid:
  mock-{orderId} }`.
- Prisma mode: finds the oldest AVAILABLE profile and atomically claims it with
  `updateMany` guarded by `status=AVAILABLE, assignedOrderId=null`,
  incrementing `version`. Retries up to 3 times; on conflict throws
  `ConflictException` "Inventory reservation conflict; retry the approval".
  When no profile exists → `ConflictException` "No eSIM inventory is currently
  available".
- `profileForOrder(orderId)` is just `reserve(orderId)`
  (`inventory.service.ts:33`).

### Import

`importBatch(iccids, eids?, source?)` (`inventory.service.ts:35-59`):

- Requires Prisma. Max 5,000 rows.
- Validates ICCID format `/^\d{15,25}$/`.
- Skips ICCIDs already present.
- Batch reference `MANUAL-{source|'ops'}-{timestamp}`.
- Synth EID when missing: `SYNTH-{sha256(iccid)[0:28].toUpperCase()}`.
- Returns `{ imported, skipped, batch }`.

`importBatchCsv(csv, source?)` (`inventory.service.ts:61-108`):

- Requires Prisma. Max 5,000 rows.
- Parses via `csvToRecords` (required column `iccid`, optional `eid`).
- Validates ICCID and optional EID `/^[A-Z0-9-]{16,80}$/`; detects duplicate
  ICCIDs within file; skips existing ICCID/EID with per-line errors.
- Returns `{ imported, skipped, errors, batch }` with errors capped at 100.

### Assignment (`assign`, `inventory.service.ts:110-132`)

- In-memory mode: no-op.
- Prisma mode transaction:
  - Inventory → `ASSIGNED`, sets `providerSubscriptionId`, bumps version.
  - Upserts `CustomerEsim` on `orderId`, storing encrypted QR payload.
  - If a provider subscription id is present, upserts `Subscription` with
    status `PENDING`.

### Lifecycle (`applyLifecycle`, `inventory.service.ts:134-166`)

- In-memory mode: no-op.
- Applies a provider event:
  - `ACTIVATED` → inventory `ACTIVATED`, subscription `ACTIVE`.
  - `EXPIRED` → inventory `EXPIRED`, subscription `EXPIRED`.
  - `TERMINATED`/`CANCELED` → subscription `TERMINATED`.
  - Other → no inventory change, subscription `PENDING`.
  - Sets activatedAt/expiresAt; bumps inventory version; upserts `Subscription`.

### Usage

`refreshUsage(orderId)` (`inventory.service.ts:189-198`):

- Requires Prisma. Looks up inventory by assigned order; calls
  `connectivity.getUsage(iccid)`; updates `Subscription.usedMb/totalMb/
  usageLastCheckedAt`; returns `{ orderId, ...usage, lastCheckedAt }`.

`customerIdForOrder(orderId)` (`inventory.service.ts:182-187`): in-memory mode
returns `memory-{orderId}`; Prisma mode reads the order's customerId.

### Overview (`overview`, `inventory.service.ts:200-206`)

- In-memory mode: zeros + `lowStockThreshold: 10`, `lowStock: true`,
  empty batches.
- Prisma mode: groupBy status counts, last 20 batches,
  `lowStock = available <= 10`.

## Controller

`inventory.controller.ts:7-25`, guarded by `AuthGuard`, `AccountGuard`
(OPERATIONS/SUPER_ADMIN) and `requireRole`:

- `GET /operations/inventory` → `overview()`
- `POST /operations/inventory/import` → `importBatch`
- `POST /operations/inventory/import-csv` → `importBatchCsv`

## Customer eSIM and subscription models

`schema.prisma:313-337`:

- `CustomerEsim` links one customer, one inventory profile, one order, and the
  encrypted QR payload.
- `Subscription` tracks provider subscription id (unique), status, activation,
  expiry, and usage (usedMb/totalMb/usageLastCheckedAt).

## Relationships to other modules

- Reservation happens at approval time (`orders.service.ts:214`).
- Assignment happens on provisioning success (`orders.service.ts:215`) or on
  an ACTIVATED provider event (`orders.service.ts:242`).
- `TransatelProvider.resolveSubscriber` reads `EsimInventory.assignedOrderId`
  to map ICCID→order for webhooks (`transatel.provider.ts:517-520`).
