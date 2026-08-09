# Changelog

All notable changes to this project are tracked here. Follows
[Keep a Changelog](https://keepachangelog.com/) — add an entry under
[Unreleased] whenever you finish a change, then move it into a versioned
section when a release/tag is cut.

## [Unreleased]

### Added
- (nothing yet)

### Changed
- (nothing yet)

### Fixed
- (nothing yet)

### Removed
- (nothing yet)

---

## 2026-08-09 — Partner API MVP & prepaid flow

Commit: `cc165aa` · Branch: `API-integratedv1`

### Added
- Partner activation delivery endpoint
  `GET /api/v1/partners/orders/:id/esim`, protected by the new
  `esims:read` scope and available when an order is `QR_READY` or
  `COMPLETED`.
- Partner order responses now expose `fulfillmentStatus`, asynchronous
  `nextAction`, polling guidance, resource links and eSIM-detail
  availability without leaking activation secrets in ordinary responses or
  webhooks.
- Durable partner lifecycle events and signed webhook deliveries for order
  acceptance, provisioning, QR readiness, activation, failure, cancellation
  and refunds; pending deliveries are reconciled every 30 seconds.
- Partner account summaries with prepaid balance, credit/debit/refund totals,
  order counts by status, fulfilled/failed counts, total order value and
  average order value.
- Partner ledger filters for date, transaction type, reference, internal order
  number and partner external order ID.
- Super Admin partner workspace at `/admin/partners/:id` with overview,
  partner-specific orders, financial ledger, date filters and CSV exports.
- Operations Orders filters for direct versus partner sales, partner, status
  and date range, with partner identity and external references included in
  search and CSV exports.
- Customer and operations recovery actions for downloading or resending a
  password-protected activation QR after an eSIM reaches `QR_READY` or
  `COMPLETED`.

### Changed
- Partner orders now use the same active `Plan.sellingPrice` as direct
  customer orders. The price is snapshotted at acceptance so later catalogue
  changes cannot alter an existing order or ledger debit.
- Partner settlement is prepaid-only for the MVP. The order and its linked
  `DEBIT` ledger entry are created atomically, insufficient balances are
  rejected, overdrafts are disabled, and retries never create a second debit.
- Partner fulfillment is asynchronous:
  `APPROVED → PROVISIONING → QR_READY → COMPLETED`. `QR_READY` means the eSIM
  can be delivered; `COMPLETED` is reserved for provider-confirmed activation.
- Accepted partner orders are recovered after API restarts, and production now
  requires `REDIS_URL` so provisioning and notification work cannot silently
  fall back to in-process execution.
- Partner cancellation and approved refunds credit the original prepaid debit
  exactly once while `PROVISIONING_FAILED` remains paid and retryable.
- New partner credentials expose only the active catalogue, order, document,
  refund, usage and eSIM scopes. Partner quotes, channel-specific price lists
  and payment scopes are no longer part of the active MVP contract.
- Partner API documentation now describes prepaid settlement, unified public
  pricing, asynchronous order states, polling, activation retrieval and
  webhook behavior.
- Payment and customer-source contracts now standardize on Khalti as the only
  hosted payment provider.

### Fixed
- Prepaid debits now use an optimistic, balance-guarded update so concurrent
  orders cannot overspend the same partner balance.
- `StatusBadge` now handles missing labels safely instead of throwing while
  rendering operations data.
- QR-ready orders no longer appear incomplete to partner clients; activation
  details are available at both `QR_READY` and `COMPLETED`.

### Removed
- ESEWA payment enums, gateway registration, gateway implementation and
  advertised Partner API capability.
- Hosted-payment and quote-based partner order creation. These mutation paths
  now return HTTP `410` with stable deprecation codes while historical records
  remain readable.
- Partner-specific wholesale/retail pricing from active order creation and the
  operations workflow; historical price-list tables are retained for data
  compatibility.

### Tests
- Added `apps/api/src/modules/partners/partner-prepaid.test.ts` covering hosted
  payment deprecation, insufficient prepaid balance and guarded order-linked
  debits; expanded `partner-contract.test.ts` for default prepaid settlement.
- Full validation at implementation time: API, customer web, operations web
  and shared TypeScript checks passed; API build passed; 117/117 tests passed
  across 17 test files.

---

## 2026-08-09 — security & resilience hardening

Tag: `updated-in-terms-of-security-fixes` · Branch: `API-integratedv1`

### Added
- Ops audit entries now include `performedByEmail` and the affected entity.
- New reusable `PaginationBar` component and BOM-safe CSV download helper
  (`apps/ops-web/src/lib/csv.ts`).
- Server-side pagination + debounced search for `/operations/orders` and
  `/operations/customers` (`apps/api/src/common/paginate.ts`); ops UI gained
  search, paging and "Export CSV".
- Ops refinement: Refund and Cancel actions now use confirmation dialogs
  (with required reason + destructive styling) instead of the browser prompt.
- API resilience: `reconcileStaleActivationOrders` re-queries the provider
  `getEsimDetails` up to `ACTIVATION_REFETCH_ATTEMPTS` (default 3) so a lost
  ACTIVATED webhook is recovered instead of failing a QR_READY order on a
  timer (shared `completeProviderActivation` path).
- API resilience: `PaymentsService.reconcilePendingPayments` runs on the
  reconciliation timer and issues a final gateway `verify()` for pending
  payments past their window (completed → recovered; unreachable → deferred
  up to `PAYMENT_VERIFY_ATTEMPTS`, default 3, then failed).

### Changed
- Ops `middleware.ts`: `/admin*` routes now require `SUPER_ADMIN`;
  OPERATIONS is redirected to `/unauthorized` (was client-only).
- Ops audit page: rebuilt with Actor column, corrected field mapping,
  keyword search and CSV export (`apps/ops-web/src/app/audit/audit-client.tsx`).

### Fixed
- Partner complete-order creation: `z.optional()` settlement produced an
  explicit `undefined` member incompatible with `CompleteOrderInput` under
  `exactOptionalPropertyTypes` after the Khalti-only payment standard;
  now normalized before the service call (api typecheck green).

### Tests
- Added `apps/api/src/modules/orders/orders-resilience.test.ts` (5 tests):
  activation re-fetch recovery, budget-exhausted failure, non-stale orders
  untouched, payment recovery and defer-then-fail. API suite: 116/116.

### Removed
- (none from this session; pre-existing working tree removed the ESEWA
  gateway as part of the Khalti-only payment migration)

---

## How to use this changelog going forward

1. **Always update it when you make a change.** Before (or right after)
   committing a code change to the repo, add a short bullet describing it.
   This is part of "done" — it is not optional.

2. **Goes under `[Unreleased]` first.** Put the entry in the matching
   subsection (`Added` / `Changed` / `Fixed` / `Removed` / `Tests`). If a
   category is missing, add it.

3. **Explain impact, not internals.** Say what changed from a user/operator
   perspective and name the file or endpoint where relevant, but skip
   implementation chatter. E.g.
   > `Fixed` — Guest top-up lookup now falls back to the database before
   > returning "not found" when the in-memory cache is cold.

4. **Include a `Tests` entry** whenever tests were added/changed, with the
   test file path and the current suite result.

5. **Cut a section on every tag/release.** When you create a git tag (or a
   notable deploy), turn `[Unreleased]` into a dated section:
   - Replace `[Unreleased]` with `## 2026-08-09 — <short title>`.
   - Add the metadata lines right under it:
     `Tag: \`<tag-name>\` · Branch: \`<branch>\``
   - Reset the list under a fresh `## [Unreleased]` (all "nothing yet").
   - Move the `[Unreleased]` entries into the new section before resetting,
     so nothing is lost when the tag is cut.

6. **One file only.** Never create a second changelog. This file is the
   single source of truth for change history.
