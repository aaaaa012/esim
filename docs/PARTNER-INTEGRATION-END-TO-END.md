# Partner Integration — End to End

This document explains the **entire** journey of a Visa Compass partner, from
onboarding to a fully provisioned eSIM, covering **both** integration models:

1. **API partner** — the partner integrates the Partner REST API (v2.0) into
   their own application. Suitable for partners with an engineering team.
2. **Portal / Hosted (no-code)** — the partner does **zero** API integration.
   They call a single endpoint (or use a portal UI) to create a branded
   deep-link, then share it with the traveller over WhatsApp/email. Suitable
   for travel desks, boutiques and low-capacity resellers.

Both models end in the same place: a Visa Compass order that is settled against
the partner's prepaid balance and provisioned by the connectivity provider.

---

## 1. The two partner types

|                                | **API partner**                          | **Portal / Hosted (no-code)**                            |
| ------------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| Partner engineering needed     | Yes (REST + uploads optional)            | None                                                     |
| Where the traveller checks out | In the **partner's** app                 | On a **Visa Compass-hosted**, partner-branded page       |
| How the order is created       | Partner calls full order endpoints       | Partner creates a session, traveller finishes via a link |
| Identity                       | `externalCustomerId` → `PartnerCustomer` | Same — via the deep-link                                 |
| Settlement                     | Prepaid partner account                  | Same — prepaid partner account                           |
| Provisioning + webhooks        | Yes                                      | Yes                                                      |

**The business problem this solves:** not all resellers can integrate a REST API
with scopes, idempotency keys and document uploads. The hosted model lets any
partner sell eSIMs without writing code, while attributing every order and its
settlement back to that partner.

---

## 2. Onboarding (common to both)

Before any sales, an operator creates the partner in the admin area. The
`Partner` record carries:

- `name`, `code` (required) and an optional `slug` (used to build branded
  deep-links, e.g. `shop.visacompass.com/partner-checkout/<token>`).
- `brand` (JSON) — logo URL and colours, rendered on the hosted page so the
  traveller sees _their_ agency, not Visa Compass.
- `status` (`PENDING` / `ACTIVE` / `SUSPENDED`).
- `allowedSettlementMethods`, `redirectAllowlist`, `rateLimitPerMinute`.

The operator then issues **API credentials** (`partner-admin`):
`POST /api/v1/admin/partners/:id/credentials`. Each credential has
`keyPrefix`, a secret, and **scopes** (e.g. `catalog:read`, `orders:write`,
`documents:write`, `esims:read`, `refunds:write`, `usage:read`). The partner
authenticates with `Authorization: Bearer vc_partner_<prefix>.<secret>` and is
rate-limited per minute.

The partner's **prepaid account** (`PartnerAccount`) holds
`balancePaisa + creditLimitPaisa`. Every order debits this balance; the operator
or partner tops it up via credits (`PartnerLedgerEntryType.CREDIT`).

---

## 3. Model A — API partner flow

```
[Partner app] ──(1) GET /plans───────────────────► Visa Compass API
[Partner app] ──(2) POST /document-upload-sessions─► returns signed Cloudinary URLs
[Partner app] ──(3) upload bytes────────────────────► Cloudinary
[Partner app] ──(4) POST /orders (complete)────────► auto-verify, debit, provision
[Partner app] ──(5) GET /orders/:id/esim ──────────► activation QR when READY
```

### 3.1 Discover the catalogue

`GET /api/v1/partners/plans?country=JP` (`catalog:read`) returns active plans
with the **public selling price** (`price.amountPaisa`) and `requiredDocuments`
(`PASSPORT`, `TICKET`, and `VISA` for visa-required destinations). The partner
shows these to their customer and selects a plan.

### 3.2 Upload documents (private)

`POST /api/v1/partners/document-upload-sessions` (`documents:write`,
requires `Idempotency-Key`) declares the documents the customer will upload.
The server:

- validates types, sizes (≤ 10 MB), and that types are unique;
- signs short-lived **private, authenticated** Cloudinary upload URLs
  (`privateAssetId` per document, expires in 15 minutes);
- records a `PartnerDocumentUploadIntent`.

The partner's client uploads the bytes directly to Cloudinary. Nothing touches
the Visa Compass API for the file bytes — this keeps documents private.

### 3.3 Submit the complete order

`POST /api/v1/partners/orders` (`orders:write`, `Idempotency-Key`) is a single
atomic call that carries:

- `externalOrderId`, `externalCustomerId`,
- `planId`,
- the full `traveler` object (passport details, email, mobile),
- `documents` (`{type, uploadId}`),
- `consent` (terms/privacy/compatibility),
- optional `settlement` (defaults to `PARTNER_ACCOUNT`).

**What happens server-side, in one transaction:**

1. Validates the plan, that the required documents are declared, that each
   `uploadId` belongs to the partner for this `externalOrderId` and is
   unconsumed, and that the file bytes were actually verified.
2. **Idempotency** — a repeated mutation with the same `Idempotency-Key`
   returns the original result instead of double-ordering.
3. Computes `externalCustomerId` identity via `ensurePartnerCustomer` — creates
   or reuses a `PartnerCustomer(partnerId, externalCustomerId)` and an internal
   `Customer` (code `VP-<PARTNER>-<hash>`, source `PARTNER`). **The customer is
   identified relationally; they never need a Visa Compass login.**
4. Snapshots the plan's public selling price into `pricingSnapshot`.
5. Debits the partner's prepaid `PartnerAccount` (`DEBIT` ledger entry) and
   moves the order to `APPROVED`.
6. Enqueues provisioning and emits the `order.accepted` partner event.

### 3.4 Provisioning

`approveToProvisioning` reserves an eSIM profile from inventory and transitions
the order to `PROVISIONING`, then submits it to the connectivity provider
(Transatel/Auriga). When the provider returns an activation payload the order
reaches **`QR_READY`** — the commercial milestone — and `COMPLETED` once the
provider confirms activation.

### 3.5 Retrieve & reconcile

- `GET /api/v1/partners/orders` / `/:id` (`orders:read`) — status + timeline.
- `GET /api/v1/partners/orders/:id/esim` (`esims:read`) — the protected
  activation QR, only once `QR_READY`/`COMPLETED`. Secrets are never in lists,
  logs or webhooks.
- `GET /api/v1/partners/account` & `/ledger` — balance, reserve, debits,
  credits, refunds.
- `GET /api/v1/partners/orders/:id/usage` (`usage:read`) — live data consumption.
- `POST /api/v1/partners/orders/:id/cancel` / `/refund-requests` — manage orders.

### 3.6 Webhooks

Partners can register webhook endpoints and receive events
(`order.provisioning`, `order.qr_ready`, `order.activated`,
`order.provisioning_failed`, `order.cancelled`, `order.refunded`). The webhook
processor retries delivery and records attempts — the partner's system stays in
sync without polling.

---

## 4. Model B — Portal / Hosted (no-code) flow

```
[Partner staff] ──(1) POST /hosted-checkout-sessions──► creates DRAFT order + session, returns checkoutUrl
[Partner staff] ──(2) share checkoutUrl (WhatsApp/email)──► traveller
[Traveller] ──────(3) opens link → branded hosted page
[Traveller] ──────(4) traveller details
[Traveller] ──────(5) upload documents (private)
[Traveller] ──────(6) passport verified (OCR)
[Traveller] ──────(7) accept + complete
[Visa Compass] ───(8) auto-verify → debit partner → provision
```

### 4.1 Create the session

`POST /api/v1/partners/hosted-checkout-sessions` (`orders:write`,
`Idempotency-Key`) with `{planId, externalOrderId, externalCustomerId}` —
**this is the only call a no-code partner ever makes.**

Serverside it:

1. Validates the plan is active.
2. Checks `externalOrderId` isn't a duplicate for the partner.
3. Creates the `PartnerCustomer` identity (same as the API path).
4. Creates a **DRAFT** order using the partner's prepaid `PARTNER_ACCOUNT`
   settlement, snapshotting the public price.
5. Creates a single-use, **24-hour** `PartnerHostedCheckoutSession`
   (only the SHA-256 of the token is stored).

It returns `{sessionId, token, checkoutUrl, orderId, externalOrderId}`. The
partner shares `checkoutUrl` (e.g. `https://shop.visacompass.com/partner-checkout/<token>`)
with their customer over WhatsApp or email. There is nothing more for the
partner to do.

### 4.2 The branded hosted page

The public page (no login) loads `GET /partner-checkout/:token`, which returns
the order, price, plan, required documents, and the partner's `brand`
(name/logo). The header shows **"Checkout via <partner name>"**, so the
traveller knows they're buying through their trusted agency, not Visa Compass.

### 4.3 Traveller details

The traveller fills the form; `POST /partner-checkout/:token/traveler` saves it
(encrypted: DOB, passport number, expiry are encrypted at rest; the passport
number also gets a blind index for lookups).

### 4.4 Documents

`POST /partner-checkout/:token/documents` returns a **private** Cloudinary
upload URL; the browser uploads the file directly, then
`POST /partner-checkout/:token/documents/:documentId/confirm` verifies it
(≤ 10 MB, PDF/JPG/PNG).

### 4.5 Passport verification (the business-critical gate)

`POST /partner-checkout/:token/verify-passport` runs the **server-side OCR
check** (Tesseract): it downloads the uploaded passport (rasterised to a JPEG —
PDFs are read as page 1), extracts text, and compares it with the traveller
form. The verdict is:

- `VERIFIED` — passport number **and** ≥ 1 more field (name/DOB/expiry) match,
- `PARTIAL` — only the passport number matched,
- `FAILED` / `NOT_READY` — no match / missing data,
- `SKIPPED` — local simulator (document storage not configured) only.

The verdict is persisted on the passport document. This is what stops a
mismatched traveller slipping through **auto-approved** partner orders.

### 4.6 Complete

After the traveller accepts consent, `POST /partner-checkout/:token/complete`
runs **in one transaction**:

1. Re-verifies that every required document exists and is valid.
2. **Requires the passport verification to be `VERIFIED` (or `SKIPPED` in the
   simulator)** — otherwise it returns `PASSPORT_VERIFICATION_REQUIRED` and the
   order is not completed.
3. Debits the partner's prepaid `PartnerAccount`.
4. Moves the order `DRAFT → APPROVED`, records consent, and consumes the
   session (the token can no longer be reused).
5. Hands off to the **same provisioning pipeline** as the API model →
   `PROVISIONING → QR_READY`, emitting partner webhooks along the way.

The traveller sees a success screen; the partner's balance is debited and their
webhooks fire, exactly as if they had placed the order themselves.

---

## 5. Identity, consistently

There is **one identity model regardless of partner type**:

```
PartnerCustomer(partnerId, externalCustomerId)  ──►  Customer (internal, source=PARTNER)
```

- No traveller account or login is ever required.
- The same traveller ordering twice under the same
  `(partnerId, externalCustomerId)` maps back to the **same** internal customer.
- For hosted flows the extra customer identifier (a phone number or agency
  record number) is chosen by the partner when they create the session.

---

## 6. Settlement, consistently

Both models settle against the partner's prepaid account:

| Ledger entry              | When                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `CREDIT`                  | The partner/operator tops up the balance                                           |
| `DEBIT`                   | An order is placed/completed (API model at order submit; hosted model at complete) |
| `RESERVATION` / `RELEASE` | Older quote flows (legacy); reservations may be released on cancel                 |
| `REFUND`                  | A refund is approved and issued                                                    |
| `ADJUSTMENT`              | Manual corrections                                                                 |

The ledger and account endpoints give partners full reconciliation.

---

## 7. Refunds, orders & notifications (both models)

- **Cancellation / refunds**: `POST /orders/:id/cancel` releases/prepares a
  refund; `/refund-requests` sends a formal request to the ops review queue.
- **Notifications**: partners can trigger `EMAIL` / `WHATSAPP` templates
  (`ORDER_STATUS`, `QR_READY`, `DOCUMENT_REUPLOAD`).
- **Simulator**: when Cloudinary and/or the connectivity provider are
  unavailable (non-production), the API gracefully runs in `local-simulator`
  mode — uploads and provisioning are simulated, and passport verification
  returns `SKIPPED` — so the whole flow can be demoed without live services.

---

## 8. Security, reliability & limits

- **AuthN**: Bearer partner keys, scoped per credential.
- **AuthZ**: scope checks per endpoint; suspended partners cannot mutate.
- **Idempotency**: every mutation requires an `Idempotency-Key`; duplicates
  return the cached response.
- **Rate limiting**: per-partner per-minute budget + response headers.
- **Confidentiality**: passport fields encrypted at rest; activation secrets
  never in logs/lists/webhooks; documents are private, authenticated, and
  short-lived.
- **Hosted sessions**: single-use tokens, hashed at rest, 24-hour expiry.

---

## 9. Migration note

Two pending migrations enable the newer features (passport verification columns
and the partner `slug`/`brand` + hosted sessions). Apply them before a live
deploy:

```
pnpm db:migrate
```

The hosted `checkoutUrl` is built from the `CUSTOMER_WEB_URL` environment
variable (defaults to `http://localhost:3000`).
