# 20 — Documentation Gaps

This file records behavior that is `UNKNOWN / NOT DETERMINABLE FROM CODE`,
inconsistencies found during reverse-engineering, and places where the
documentation set had to make an assumption.

## UNKNOWN / NOT DETERMINABLE FROM CODE

- **Production secrets and exact provider payloads.** Khalti/Transatel
  request and response bodies, error shapes, and rate limits are modeled only
  from the code's usage; exact wire contracts live on the providers' APIs and
  are not captured in the repo. When a provider returns an unexpected shape,
  `payments.service.ts` / `transatel.provider.ts` map it to `UNEXPECTED`.
- **Business acceptance rules.** Which visa/passport combinations are
  acceptable is human judgement in ops review; no automated policy exists.
- **Scheduler drift / job durability.** `QueueService` is in-process
  (`docs/12`); no cross-process guarantees.

## Confirmed inconsistencies / rough edges

1. **Payments webhook has no production signature verification.**
   `webhooks.controller.ts:36-45` only verifies `x-visa-signature` when
   `NODE_ENV !== 'production'` and the header is present; in production any
   caller can post `{ eventId }`. The later `verifyCallback` still validates
   order/amount/status invariants, but the endpoint itself is not
   authenticated. Flagged in `docs/15`.
2. **`CustomerSource` value `KHALTI` is never set.** The Prisma
   schema defines `CustomerSource` including `KHALTI`, but no code path
   sets it from the payment provider — orders created via payment flows use
   `WEB`/`CLERK`-derived sources (see `docs/13`). UNKNOWN whether a real
   provider integration would set it.
3. **`/auth/me` landing portal URLs are hard-coded**
   (`auth.controller.ts:25-28`: `http://localhost:3000/account/esims` /
   `http://localhost:3001/`), not derived from `CUSTOMER_WEB_URL` /
   `OPS_WEB_URL` even though `main.ts:17` uses those env vars for CORS.
4. **`PAYMENT_MODE` semantics.** `payments.service.ts:25` selects the real
   gateway when `PAYMENT_MODE === 'sandbox'` **or** `NODE_ENV ===
'production'`; there is no explicit "simulator" string — any value other
   than `sandbox` (outside production) selects the simulator. `.env.example`
   documents this, but it is a common misreading.
5. **Rate limiter is per-process.** `rate-limit.guard.ts` keeps buckets in
   memory (`docs/19`); multi-instance deployments need a shared store. The
   health check reports Redis as `configured`/`not-configured`
   (`health.controller.ts:29`) but Redis is not used by the limiter or queue.
6. **`safeNotify` trigger path for `DOCUMENT_REUPLOAD`.** `safeNotify` is
   defined in `notification.service.ts` and called during `requestReupload`
   / document transitions (`docs/07`, `docs/11`); the call site at
   `orders.service.ts:261` is confirmed, but the exact ordering vs. the
   state-machine transition and whether other paths emit the same template is
   only partially verifiable from code.
7. **Simulator inventory seeding is dev-only.** `inventory.service.ts:14`
   returns early when Prisma is disabled or in production, so seeded
   inventory only exists locally.
8. **Email/WhatsApp simulation in non-prod.** `gmail.channel.ts:11` and
   `whatsapp.channel.ts:8` return `simulated: true` payloads outside
   production instead of sending — expected for dev, but means notification
   delivery is untested against real providers here.

## Confirmed inconsistencies / rough edges

9. **Approval-gate migrations are pending.** `BatchStatus` enum and the
   `InventoryBatch` approval columns, plus the DRAFT-on-import plan behavior,
   require `20260806000200_inventory_batch_approval`. Until applied, the
   fields (and the audit rows they power) do not exist in a running DB.
10. **`/metrics` is in-memory and resets on restart** (`metrics.service.ts`);
    `/health/ready` Redis `PING` opens a short-lived connection per check
    (`health.controller.ts`), which is fine at low volume but not a pooled
    path.

## Assumptions made in this documentation set

- Endpoint lists in `docs/04` are from controller decorators; response shapes
  are from the services, and fields present in Prisma models but unused by the
  service code are marked as available-but-unused rather than asserted live.
- Zod schemas (`docs/16`) are the source of truth for request validation;
  `ValidationPipe` whitelists unknown fields, so extra request properties are
  dropped before handlers run.
- The "46 tests" figure sometimes repeated in earlier notes was not
  re-verified; the confirmed suite is the 7 Vitest files listed in
  `docs/02`/`docs/16`.
