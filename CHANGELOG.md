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