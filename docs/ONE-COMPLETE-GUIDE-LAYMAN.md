# Visa Compass — The Whole System, Explained Simply

A single plain-English walkthrough of **everything** in the codebase: every journey,
every screen, every background job, every edge case, and every security control.
Read it top to bottom and you will understand the entire product. File references
point at the exact source so you can verify any claim.

> Two portals (customer + operations) talk to one backend (the API) which talks to
> five outside services: **Clerk** (who you are), **Khalti** (payments), **Transatel**
> (the actual mobile-network eSIMs), **Amazon S3** (secure document storage) and
> **Amazon SES / WhatsApp** (messages). The product sells international travel eSIM data
> plans in Nepali Rupees (NPR).

---

## 1. The cast of characters

| Who                      | Where they live            | What they can do                                                                                                        |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Customer** (signed in) | customer-web, port 3000    | Browse plans, buy, upload documents, pay, download their eSIM QR, view usage. Owns their own orders only.               |
| **Guest** (no account)   | customer-web, checkout     | Same purchase flow but without signing in. Gets a one-time secret token attached to their order.                        |
| **Operations staff**     | ops-web, port 3001         | Review documents, approve orders, retry failures, import eSIM inventory, refunds, top-up lookup.                        |
| **Super Admin**          | ops-web, port 3001         | Everything ops can do, plus: manage users/staff invitations, edit plans, trigger Transatel catalog sync, system config. |
| **Partner**              | A third-party API consumer | Uses their own API key to create orders and check status for their own customers (B2B).                                 |
| **Clerk**                | External                   | Login/registration. Issues the "I am this person" tokens (JWTs).                                                        |
| **Khalti**               | External                   | Takes customer money.                                                                                                   |
| **Transatel**            | External                   | Actually provisions the eSIM on the mobile network and reports usage.                                                   |
| **Amazon S3**           | External                   | Holds uploaded passport/ticket scans privately.                                                                         |
| **Amazon SES / WhatsApp**    | External                   | Deliver eSIM QR images and status messages.                                                                             |

---

## 2. The one idea that runs the whole thing: the "Order" and its state machine

Everything is built around a single record: an **Order**. An order is "a plan that a
person is buying, at one moment in time, with a price snapshot". It carries:

- the chosen **plan** (country, data allowance, validity days, price),
- the **traveler** (name, DOB, passport, email, mobile — passport & DOB are encrypted),
- the **documents** (passport scan, flight ticket scan, optional visa),
- the **payment** record (reference, status, expiry),
- a **timeline** (every status change with a timestamp and reason).

An order can only ever move along a legal path — a "state machine". Think of traffic
lights: you cannot go from red to green to red instantly. The legal paths live in
`apps/api/src/modules/orders/order-machine.ts`:

```
DRAFT
  ├─▶ PAYMENT_PENDING ─▶ PAYMENT_CONFIRMED ─▶ APPROVED ─▶ PROVISIONING ─▶ COMPLETED
  │       │                   │  (docs need human review)                    │
  │       │                   └─▶ REVIEW_PENDING ──▶ AWAITING_CUSTOMER ─┐    │
  │       │                        │  ▲            │                     │    │
  │       │                        │  └────────────┘ (customer re-uploads)│    │
  │       │                        └─▶ APPROVED ─▶ PROVISIONING ──────────┘    │
  │       │                                                          └─▶ PROVISIONING_FAILED
  │       │                                                              │  (retry)
  │       └─▶ PAYMENT_FAILED ─▶ PAYMENT_PENDING  (try paying again)
  │                 │
  └─▶ CANCELLED     └─▶ CANCELLED
  (and from many states) ─▶ REFUND_PENDING ─▶ REFUNDED
```

If code ever tries an illegal jump (e.g. COMPLETED → CANCELLED), it throws — so no
order can ever be "un-completed" by accident or by attack.

---

## 3. Journey 1 — A signed-in customer's very first purchase

Everything is plain JSON to and from `POST /api/v1/...`. The browser (customer-web)
does the calling; the server checks who you are on every request.

1. **Browse.** `GET /api/v1/public/plans` returns active plans (price, data, days,
   country, "popular" flag). No login needed — it's a shop window.
   → `apps/api/src/modules/catalog/catalog.controller.ts`

2. **Start an order.** `POST /api/v1/customer/orders` with `{ planId, compatibilityAccepted: true }`.
   The compatibility checkbox is mandatory — a human must confirm their phone supports
   eSIM. The server checks the plan is **active**, mints a UUID order id, an order
   number like `VC-2026-AB12CD34`, and a `DRAFT` order. Your IP address + user-agent
   are recorded as a consent record.
   → `OrdersService.create`

3. **Who are you?** Each call carries a Clerk JWT. The API verifies it with Clerk's
   secret, then looks up your local account. If you're disabled or blocked → 403.
   → `apps/api/src/common/auth.guard.ts`

4. **Fill in traveler details.** `PATCH /api/v1/customer/orders/:id/traveler`.
   A strict form (Zod schema in `packages/shared/src/schemas.ts`) validates every
   field: names 1–80 chars, ISO dates, 2-letter country codes, valid email, mobile
   7–20 digits, passport 5–30 chars. Anything weird → clear validation error, nothing
   is stored.

5. **Upload documents.** `POST .../documents` returns a **presigned Amazon S3 upload URL**
   (with a required method, headers, and expiry) so the browser can upload the file _straight to
   Amazon S3_ — the passport/ticket never passes through our server. Then
   `POST .../documents/:docId/confirm` makes the server check the file really exists
   and is a PDF/JPG/PNG under 10 MB. Passport and Ticket are required; Visa is
   optional.
   → `apps/api/src/infrastructure/s3-storage.service.ts`

6. **Pay.** `POST .../payment` with provider `KHALTI`. The server double-checks the
   traveler is filled in and both documents are uploaded **and verified**; only then
   does it move the order `DRAFT → PAYMENT_PENDING` and ask Khalti to create a payment
   (amount in paisa = NPR × 100). Khalti answers with a reference (`pidx`) and a
   redirect URL. The browser sends the customer to Khalti's page.

7. **Return + verify.** Khalti bounces the customer back to
   `/esim/checkout?order=...&reference=...`. The browser calls
   `POST .../payment/verify` with that reference. The server **does not trust the
   browser** — it asks Khalti directly: _is this payment Completed? does it belong to
   this order? is the amount exactly right?_ Only if all three match does it mark
   `PAYMENT_CONFIRMED`. Amount/order mismatch → error, order stays unpaid.
   → `PaymentsService.verify`, `KhaltiGateway.verify`

8. **Auto-approve + provision.** Because the passport and ticket were already verified,
   the order is auto-approved: `PAYMENT_CONFIRMED → APPROVED → PROVISIONING`, and a
   **provisioning job** is queued.

9. **Reserve a real eSIM.** The server takes the oldest available eSIM profile from the
   inventory (status `AVAILABLE → RESERVED`) and atomically links it to this order so
   two orders can never grab the same one.
   → `InventoryService.reserve`

10. **Ask Transatel to activate it.** The server sends a "preload" order to Transatel
    (plan product id + the eSIM identifier). Transatel replies with a subscription id
    and (usually) the activation QR. The QR is encrypted at rest. The inventory profile
    becomes `ASSIGNED` and the order moves to `COMPLETED`.
    → `OrdersService.processProvisioning`, `TransatelProvider.provision`

11. **The QR arrives by email.** A background job renders the QR as an unencrypted
    PNG image and emails it through Amazon SES. The QR is _the credential that installs
    the eSIM_, so the email template warns the customer not to share it.
    → `apps/api/src/jobs/integration.processor.ts`, `ses-email.channel.ts`

12. **Watch usage.** `GET .../usage` shows used MB / total MB. This comes fresh from
    Transatel's balance API, cached per subscription and refreshed by a background job.
    → `InventoryService.refreshUsage`, `TransatelProvider.getUsage`

### First purchase — edge cases worth knowing

- **Plan becomes inactive** mid-buy → order creation fails with "Invalid or inactive plan".
- **Docs already uploaded but you refresh** → checkout resumes the order by id (only if it
  is still `DRAFT`/`PAYMENT_PENDING`; anything later is "no longer resumable").
- **You close the tab after paying** → the browser checks for a return reference and
  verifies automatically on reload.
- **Passport/ticket missing when paying** → hard error, you cannot pay until they exist.
- **Document is the wrong type or too big** → Amazon S3 verify rejects it.
- **QR not ready when Transatel answers** (provisioning status `DELAYED`) → the server
  waits for Transatel's **webhook** to deliver activation, then completes the order.
  → `OrdersService.applyProviderEvent`

---

## 4. Journey 2 — Guest checkout (no account at all)

Exactly the same product, but the customer never signs in. The clever bit: when the
server creates the order (`POST /api/v1/guest/orders`) it also returns a **token** =
`HMAC(order id, GUEST_ORDER_SECRET)`. Every later call must present that token in the
body (or query for GET). The server re-computes the HMAC and compares with a
constant-time check. Someone who does **not** have the token cannot touch the order,
even if they guess the order id — and because the secret lives only on the server, a
customer cannot mint tokens for other people's orders.
→ `apps/api/src/modules/orders/guest-orders.controller.ts`

The browser keeps the token in `sessionStorage` (`vc_guest_token`) and simply rewrites
`/customer/orders/*` calls to `/guest/orders/*` when the user isn't signed in.
→ `apps/customer-web/src/app/esim/checkout/checkout-client.tsx`

Guest edge cases:

- **Token lost** (cleared storage) → every call returns 403 "Invalid or expired guest token";
  the order is orphaned. (There is no account to fall back on by design.)
- **Guest order abandoned** → `POST .../payment/abandon` (with token) marks it
  `PAYMENT_FAILED`. Ops can cancel or it just sits as data.
- **Guest top-up** (below) works the same way, using the mobile number instead of an
  account to recognise the returning subscriber.

---

## 5. Journey 3 — Top-up (same person, another data plan)

This is where the "remembering" happens. Two ways in:

**A. Signed-in customer:** if their account already has a `COMPLETED` order, the system
automatically treats the new purchase as a **TOP-UP**. No documents, no traveler form —
it reuses the stored identity and jumps straight to payment.

**B. Guest by mobile number:** on the home page a visitor can enter their number
(`POST /api/v1/guest/orders/topup-lookup`). The server checks whether that number has a
previous `COMPLETED` order and returns the **current plan, country, usage, expiry and
"has an active eSIM"**. This is a privacy-sensitive lookup, so it's heavily rate-limited
_per number_ and _per IP_ (see Security).
→ `OrdersService.topUpLookup`, `apps/api/src/common/guest-lookup.rate-limit.guard.ts`

If found, checkout is pre-filled: it remembers the mobile, skips traveler+documents
(`step 4` = payment directly), and when the order is created the server pulls the email
from the prior completed order so the QR image can be emailed.

### Country change (the subtle one)

At provisioning, the server compares the **prior order's country** with the **new plan's
country**:

- **Same country** → it reuses the _same physical eSIM_ (a second "subscription" stacked
  onto it). `assignTopup` links the new order to the existing inventory, so plans can
  stack and expire independently.
- **Different country** → it must provision a **new physical eSIM** for the new country,
  reserving fresh inventory. Your old eSIM for the old country remains whatever it is;
  the new country gets its own SIM profile.
  → `OrdersService.processProvisioning` (`reuseExisting` logic), `InventoryService.assignTopup`

Top-up edge cases:

- **Number doesn't exist** → `found: false`; they're sent to the normal first-purchase flow.
- **Prior order's email missing** → the QR can't be emailed; notification is silently
  skipped (logged), order still completes.
- **Prior eSIM is from a different country** → new physical eSIM (see above).

---

## 6. Journey 4 — Payment, in full detail

There are two "payments worlds" controlled by config (`PAYMENT_MODE`):

| Mode                             | What actually happens                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `simulator` (default in dev)     | A fake gateway creates a reference; the browser is redirected to `?simulated=1&reference=...`. A dev-only endpoint `POST .../payment/simulate` completes/fails it. |
| `khalti` (sandbox or production) | Real money. `KHALTI_BASE_URL` dev/sandbox vs `https://khalti.com/api/v2`.                                                                                          |

Every payment record tracks: **reference**, **status** (INITIATED/PENDING/COMPLETED/
FAILED/CANCELLED/REFUNDED), optional **correlationId**, **expiry**, and **returnUrl**.

Life of a payment:

1. `initiate` — DRAFT→PAYMENT_PENDING, store reference.
2. `verify` — server-side lookup; success only on COMPLETED + order match + amount match.
3. `confirmPayment` — PAYMENT_CONFIRMED, then auto-approve/provision.
4. Webhook/callback path — `POST /api/v1/webhooks/payments/:provider` carries an
   `eventId`; it's **deduplicated** (a unique DB row + an in-memory set), signature-checked,
   then a queue job re-runs `verifyCallback` (which re-looks-up with Khalti — so even a
   forged callback can't complete a payment that didn't really happen).
   → `apps/api/src/modules/webhooks/webhooks.controller.ts`, `IntegrationProcessor.payment`

### Payment failure / cancellation / timeout — every branch

- **User abandons the Khalti page** → they hit `.../payment/abandon` → `PAYMENT_FAILED`.
  They can try again (`PAYMENT_FAILED → PAYMENT_PENDING`) or cancel.
- **Khalti reports "Expired"/"User canceled"** → `FAILED`/`CANCELLED`.
- **Wrong amount returned** → verify refuses; order stays `PAYMENT_PENDING`.
- **Payment window expires** → ops runs `POST .../payments/expire-stale` which finds
  overdue `PAYMENT_PENDING` orders and marks them `PAYMENT_FAILED`.
- **Refund** uses dual control for Khalti and Fonepay. Operations may request
  one only for a confirmed, not-yet-refunded payment. A Super Admin approves
  or rejects it. Staff completes the money movement in the original provider,
  then a Super Admin records the exact full amount, completion time and unique
  provider reference. Only that final atomic action marks the payment and order
  `REFUNDED`; requesting or approving never sends money or changes paid state.
- **Simulator timeout scenario** is blocked in production (`simulate` endpoint refuses to
  run when `NODE_ENV=production`).

### Replay protection

- **Idempotency keys**: the browser sends a fresh `x-idempotency-key` header on every
  mutation. The server stores (route+actor+key) → (request hash → response). Replaying
  the same key with the same body returns the _stored response_ (no double-charge); the
  same key with a _different_ body is rejected with a conflict.
  → `apps/api/src/common/idempotency.interceptor.ts`
- **Duplicate webhook events** are dropped by `(provider, eventId)`.

---

## 7. Journey 5 — The Transatel conversation, field by field

This is the plumbing that actually puts a working eSIM on a phone. The product
talks to one external company — **Transatel** — which runs the mobile network the
eSIM lives on. Every request, response and webhook is described below, field by
field, so you can read the exact JSON going over the wire. All of it lives in one
file: `apps/api/src/modules/integration/transatel.provider.ts`.

### The two identifiers: ICCID vs MSISDN (the single most important idea)

Every SIM has **two** numbers, and Transatel keys different APIs on different ones:

| Identifier | What it is                                                                                                | Where Transatel requires it                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **ICCID**  | The SIM's **serial number** (15–25 digits), printed on the plastic card and in Transatel's delivery file. | The eSIM-details endpoint (`sim-serial/{iccid}`), and webhooks arrive identified by it. |
| **MSISDN** | The **phone number** attached to the SIM (6–15 digits, **no `+` and no leading `00`**).                   | The order-binding call (`bind.msisdn`) and the usage-balance call (`?msisdn=...`).      |

When Transatel ships SIMs, the delivery file (CSV/Excel) contains the columns
**ICCID, MSISDN, PIN, PUK, Status**. Ops imports that file; if the file has the
`msisdn` column, we store it on the inventory row so every later Transatel call
uses the SIM's real phone number. If no MSISDN was imported, we fall back to the
ICCID as the binding identifier. We store both per SIM (`EsimInventory.iccid`,
`EsimInventory.msisdn`) — the code resolves which one to send per endpoint.
→ `apps/api/src/modules/integration/transatel.provider.ts` (`resolveSubscriber`)

### First, get a token (OAuth2 client credentials)

Before any data call, the provider exchanges its credentials for a short-lived
access token:

- `POST {base}/authentication/api/token` with `Authorization: Basic base64(clientId:clientSecret)` and body `grant_type=client_credentials`.
- Response: `{ access_token, expires_in, ... }`. The token is cached and refreshed
  ~30 s before expiry; if a call ever returns 401, we discard and fetch once more.

Every other request sends `Authorization: Bearer <token>`.

### Provisioning — the "preload" order

When a paid order is ready to activate (auto-approve or ops approve), the server
reserves a SIM then POSTs to `{base}/ocs/subscriptions/api/orders/products` with
exactly this JSON:

```json
{
  "bind": { "msisdn": "9779841234567" },
  "source": "api",
  "orderType": "preload",
  "mvnoRef": "M2MA_WW_TSL_VISA...",
  "product": { "productId": "<plan.providerPlanId>" },
  "payment": { "provider": "customer" },
  "transactionReference": "<our order UUID>"
}
```

Field by field:

| Field                  | Value                                             | Meaning                                                                                |
| ---------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `bind.msisdn`          | The SIM's stored MSISDN (falls back to its ICCID) | "Attach this plan to this subscriber." Transatel binds by phone number.                |
| `source`               | `api` (always)                                    | We are an API integration, not a portal user.                                          |
| `orderType`            | `preload` (always)                                | Buy the data up-front; it activates when the SIM first connects.                       |
| `mvnoRef`              | `TRANSATEL_MVNO_REF`                              | Our MVNO agreement reference (e.g. `M2MA_WW_TSL_VISA...`).                             |
| `product.productId`    | `plan.providerPlanId`                             | Transatel's id for the plan (from catalog sync), _not_ our plan UUID.                  |
| `payment.provider`     | `customer` (always)                               | The end customer pays. (There is no longer a `TRANSATEL_PAYMENT_PROVIDER` env switch.) |
| `transactionReference` | our order UUID                                    | Lets us/Transatel tie the OCS record back to our order.                                |

Response (201, `status: "done"`): `{ id, orderReference, status, submissionDate,
bind: { msisdn }, source, mvnoRef, subscriptionId?, transactionReference }`. The
**subscription id** we keep is `subscriptionId ?? id`. Immediately after, the server
calls the eSIM-details endpoint for the ICCID: if a QR comes back, the order
completes at once; if not (`DELAYED`), the order waits for Transatel's activation
**webhook** to complete it.
→ `transatel.provider.ts` (`provision`)

### eSIM details (status + QR) — keyed on the ICCID

`GET {base}/sim-management/sims/api/esims/sim-serial/{iccid}` returns
`{ simSerial, status, statusDate?, activationCode?, eid?, matchingId?,
smdpAddress?, qrCode: { value, dataUrl }? }`. The QR we store/send to the customer
is `qrCode.value ?? activationCode` — that string is what installs the eSIM. The
ICCID is used here because this is a query about the _physical SIM_, not about a
subscription.

### Usage balance — keyed on the MSISDN

`GET {base}/ocs/inventory/api/subscriptions/products?msisdn={msisdn}&withBalances=true`
returns `{ productSubscriptions: [ { subscriptionId, status, balances: { data:
[ { resourceName, resourceUnit, resourceValue, resourceStartValue, ... } ] } } ] }`.
The provider filters out `terminated` subscriptions, picks the `KB`-unit balances,
and computes `totalMb` from `resourceStartValue` (start allowance) and `usedMb` from
`resourceStartValue - resourceValue`. A `resourceValue` of **-1 means unlimited**
(used stays 0, total stays the allowance). This is what powers the "Used / Total MB"
widget and the 15-minute reconciliation sweep.

### Eligibility ("can this number buy this plan?")

`GET {base}/ocs/catalog/api/cos/{cos}/products/{productId}?msisdn={msisdn}` — note
the response is wrapped: the server reads `data.products[0]` (a single-product
catalog), then `canSubscribe.allowed` plus optional `errorKey`/`errorMessage`. A
403/404 is treated as "not eligible for this number". Used by the admin
"eligibility" check.

### Catalog sync (products → our plans)

Plans enter the system by **two** paths, both updating the same `Plan` table:

**1. Transatel API sync.** `GET {base}/ocs/catalog/api/cos/{cos}/products?availabilityStatus=AVAILABLE&categories=One-off`
returns a `ProductCatalog` wrapper (`{ cos, products: [...] }`). For each product the
server maps: `countryList` (ISO3 → ISO2 via a built-in table), `validityPeriod`
(days, months × 30), `allowances` (KB/GB → MB; blank = "Unlimited"), and
`prices.subscriptionFee` → NPR via `TRANSATEL_FX_TO_NPR` (a `CENT` unit is ÷100).
Products with no countries, no valid validity, or no price are skipped. Each
country+product becomes an upserted `Plan` (`providerPlanId` set). Run from the
admin panel or at startup (`TRANSATEL_CATALOG_SYNC_ON_STARTUP`).

**2. CSV / Excel file upload** (`POST /admin/plans/import-csv`, super admin). Columns:
`countryiso2, name, providerplanid, dataallowance, validitydays, costprice,
sellingprice` (optional `currency`, `popular`, `status`, `coveragecountries`,
`countryname`). Validity is parsed **flexibly** — `7`, `7 days`, `7days`, `7D`,
`1 months`, `2 month` are all accepted and stored as whole days. Rows are validated
line-by-line (2-letter country, required fields, validity 1–3650 days, sane prices)
and either create or update the matching `(country, providerplanid)` plan.
→ `apps/api/src/modules/admin/admin.service.ts` (`importPlansFromTabular`,
`parseValidityToDays`)

**Validity semantics.** `validityDays` is always counted **from the activation day**:
a plan of `7 days` means the data is usable for 7 days _after the eSIM is activated_
(the server sets `expiresAt = completion/activation time + validityDays × 86400000`
when provisioning succeeds).

### Webhooks — Transatel calls us back

- **Registration.** Transatel removed API-based webhook subscriptions in
  February 2026. Configure the callback URL, shared secret and required OCS and
  subscriber events as a Data Stream in the Developer Console, then send a
  Console test event. There is deliberately no registration action in Ops.
- **Inbound.** Transatel POSTs to `POST /api/v1/webhooks/connectivity/transatel`
  (202 accepted). The signature header is `x-tsl-signature-256` (format
  `sha256=<hmac>` of the raw body using `TRANSATEL_WEBHOOK_SECRET`), verified with
  a constant-time compare; in production a missing/`sha256=`-prefixed mismatch is
  rejected. Events are **deduplicated** by `(provider, eventId)` (DB unique row +
  in-memory set), then enqueued on the `provider-callbacks` queue.
  → `apps/api/src/modules/webhooks/webhooks.controller.ts`
- **Envelope shape (exact mapping).** Per the OCS events spec, the server reads
  fields **only** from these exact locations — no fallbacks:
  ```json
  {
    "header": {
      "eventId": "627e77fc-...",
      "eventType": "OCS/PRODUCT/ACTIVATED",
      "eventDate": "..."
    },
    "body": {
      "mvnoRef": "...",
      "cos": "...",
      "msisdn": "33612345678",
      "iccid": "8988247076000000319",
      "externalReference": "<our order UUID — echoes our transactionReference>",
      "productSubscription": {
        "subscriptionId": "8c2ef95f-...",
        "subscriptionDate": "...",
        "activationDate": "...",
        "expirationDate": "..."
      }
    }
  }
  ```
  `eventType` from `header.eventType`; `iccid` from `body.iccid` only; `subscriptionId`
  from `body.productSubscription.subscriptionId` only; `activatedAt`/`expiresAt` from
  `body.productSubscription.activationDate`/`.expirationDate` only.
  → `transatel.provider.ts` (`normalizeEnvelope`)
- **Routing — how each event is bound to the right order.** Every event carries a
  per-request identifier: **`body.externalReference`**, which Transatel echoes back
  from the `transactionReference` we sent when provisioning (our order UUID). The
  server therefore binds events to orders **via `externalReference` first** (lookup
  by order id), and only falls back to `iccid → inventory.assignedOrderId` when the
  reference matches nothing. If neither resolves, the event is acknowledged but
  skipped (logged with the reference + ICCID). Events map to
  `ACTIVATED / PRELOADED / EXPIRED / TERMINATED / CANCELED / OTHER`; an **ACTIVATED**
  event while the order is still `PROVISIONING` fetches the QR, completes the order
  and emails the customer (`QR_READY`) — this is how a "QR arrives late" order
  finishes. All other events update the inventory and subscription lifecycle (status,
  activation/expiry dates).
  → `orders.service.ts` (`applyProviderEvent`), `inventory.service.ts` (`applyLifecycle`)

---

## 8. Journey 6 — What the Operations team does

Everything ops does runs through `ops-web` against `/api/v1/operations/*` (requires an
OPERATIONS or SUPER_ADMIN account; super admins additionally need MFA unless disabled by
config).

- **Dashboard** — counts of pending reviews, awaiting customers, failed provisioning,
  completed today, plus integration health (Transatel/Khalti configured?).
- **Work queue / review** — orders in `REVIEW_PENDING`. Ops opens a customer's documents
  (private preview via signed Amazon S3 URL) and either **approves** or **requests
  re-upload** (with a reason). Approving both passport+ticket moves the order to
  APPROVED → PROVISIONING → and reserves inventory. Re-upload moves it to
  `AWAITING_CUSTOMER`; the customer gets a "DOCUMENT_REUPLOAD" email and re-uploads;
  `AWAITING_CUSTOMER → REVIEW_PENDING` again.
  → `OrdersService.reviewDocument`, `requestReupload`
- **Customers** — a list of all customers (name, email, order count, completed eSIMs),
  and a profile page with their orders, eSIMs and usage. This view shows the _expanded_
  order (including the QR payload and internal ids) — staff only.
- **eSIM inventory** — live counts of Available/Reserved/Assigned/Activated, a low-stock
  warning at ≤ 10 available, batch history, and **importing**:
  - Paste ICCIDs (`POST .../inventory/import`) or upload a **CSV or Excel file**
    (`POST .../inventory/import-csv`) — columns `iccid`, optional `eid`, optional
    `msisdn` (the SIM's phone number from Transatel's delivery file). Files up to
    5,000 rows; ICCIDs must be 15–25 digits; duplicates within the file or already
    in stock are reported per-line and skipped; an EID is synthesized if none is
    provided. Storing the `msisdn` is what lets provisioning send a real phone
    number in `bind.msisdn`.
  - Every import creates a **batch** for traceability (which file, when, how many).
  - In dev only, 20 mock profiles are auto-seeded so flows work without real inventory.
    → `apps/api/src/modules/inventory/inventory.service.ts`
- **Top-up lookup** — enter any mobile, get the subscriber + identity (staff sees more).
- **Refunds** — trigger refund for a paid order (see Journey 4).
- **Usage refresh / retry** — force a usage refresh; retry a `PROVISIONING_FAILED` order.
- **Integration events & logs** — a table of every webhook received (with
  `signatureValid` flag) and every outbound Transatel call (status, latency, error),
  so ops can answer "what did Transatel say at 14:32?".

---

## 9. Journey 7 — Super Admin and platform management

Beyond all ops abilities, super admin gets `admin/*` endpoints (all MFA-gated):

- **Plan management** — edit price/popularity/status; bulk import plans from CSV/Excel
  (columns: countryISO2, name, providerPlanId, dataAllowance, validityDays, costprice,
  sellingprice; validated row-by-row, capped at 2,000 rows).
  → `apps/api/src/modules/admin/admin.service.ts`
- **Integrations** — view configuration health for Amazon SES/Khalti/Transatel/Amazon S3/
  WhatsApp; trigger Transatel **catalog sync** (pull products → create/update plans) and
  **webhook registration**; eligibility checks.
- **Users** — list all users; change account type (CUSTOMER → OPERATIONS/SUPER_ADMIN, with
  a **"final active super admin cannot be demoted or disabled"** guard) and status.
- **Staff invitations** — invite a staff member by email; Clerk creates the invitation;
  when that person signs up, the sync webhook auto-provisions their account with the
  invited role. Invitations expire in 7 days, can be revoked/reset.
- **System config** — (ops-web) surface for the settings in this document.

### The bootstrap super-admin path

If `BOOTSTRAP_SUPER_ADMIN_EMAIL` is set and there are **zero active super admins**, the
first person to sign up with that exact (verified) email is promoted to SUPER_ADMIN —
intended for first-time setup. **In production this now additionally requires
`BOOTSTRAP_SUPER_ADMIN_TOKEN`**, so merely registering the configured email can't
self-appoint. → `apps/api/src/modules/identity/clerk-sync.service.ts`

---

## 10. Journey 8 — Partners (B2B API)

A partner has an API key. Only its **SHA-256 hash** is stored in config
(`PARTNER_API_KEYS_JSON`); the plaintext is never in the codebase. Each request sends
`x-partner-api-key`; the server hashes it and compares with a constant-time check.
→ `apps/api/src/modules/partners/partner-auth.guard.ts`

Partner calls are namespaced: orders are created with an owner like
`partner:<partnerId>:<externalCustomerId>` and every order call checks that prefix, so a
partner can only ever see/manage their _own_ customers' orders (a "tenant" boundary).
They can quote, create orders, set traveler, upload documents, pay, read status/usage,
and trigger notifications. → `apps/api/src/modules/partners/partners.controller.ts`

---

## 11. The background machinery (jobs)

Two run-modes: with `REDIS_URL` set → real **BullMQ** queues; blank → everything runs
**in-process** (simulated queue) so the whole product works on a laptop.

| Queue                | What it does                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `provisioning`       | Call Transatel to activate the eSIM (3 attempts, exponential backoff).                                                                    |
| `payments`           | Process a payment callback/webhook (re-verify with the gateway).                                                                          |
| `provider-callbacks` | Turn a Transatel webhook into an order/inventory update.                                                                                  |
| `notifications`      | Send email/WhatsApp (QR image, re-upload, plan exhausted/expired).                                                                        |
| `reconciliation`     | Every ~15 min: refresh usage for active subscriptions; mark plans EXPIRED when the date passes or data runs out, then email the customer. |

Every job that touches money/activation is **idempotent** (event id, subscription id, or
idempotency key) so retries are safe. → `apps/api/src/jobs/`

---

## 12. Security — how it defends itself (plain English)

**Identity**

- Every API request is authenticated: Clerk issues a JWT, the API verifies its signature
  with `CLERK_SECRET_KEY` **and** checks the token was issued for one of our two known
  web origins. Then the account is loaded and disabled/blocked users are refused.
- **MFA**: super admins must pass Clerk MFA on ops (enforced unless
  `ENFORCE_SUPER_ADMIN_MFA=false`).
- **RBAC**: three account types → fixed capability lists; every route re-checks the role;
  order endpoints re-check ownership so a customer can't read another customer's order.

**Guest tokens** — HMAC-signed, constant-time compared, bound to the order id.

**Rate limiting** (in-memory, per process):

- 300 req/min default per IP+route; 60 req/min on auth/public; the top-up lookup gets an
  extra, aggressive 6/min per (IP + number).
- The client IP is taken from the socket / Express `req.ip` **only** — never from a
  spoofable `X-Forwarded-For`. Behind a real proxy you must set `TRUST_PROXY`; see
  `apps/api/src/common/client-ip.ts` and `main.ts`.

**Input safety**

- Strict Zod schemas + global `whitelist` pipe (unknown fields stripped → no mass
  assignment).
- Body size cap (`BODY_LIMIT`, default 5 MB) and per-file caps (2,000 plan rows, 5,000
  inventory rows, 10 MB documents, 15 MB decoded import content).
- Every failure returns a **safe public message**; internal details (DB, provider) are
  logged server-side only and never sent to the browser.

**Secrets & crypto**

- No `.env` is committed; `.env.example` documents placeholders.
- PII (passport number, DOB, passport expiry, and the eSIM QR) is encrypted with
  **AES-256-GCM** using `APP_ENCRYPTION_KEY_BASE64`; searching by passport uses an HMAC
  "blind index" so plaintext never goes into query filters.
- The webhook-signing secret has **no hardcoded fallback in production** — a missing
  `PAYMENT_SIMULATOR_SECRET` aborts instead of silently accepting forgeries.
- Webhook signatures: Clerk uses **Svix** (timestamp + signature), Transatel uses
  **HMAC-SHA256** via `X-TSL-Signature-256`, local payment callbacks use **HMAC-SHA256**.
  All comparisons are constant-time.
- **SSRF guard**: outbound Transatel/Khalti URLs come from environment config only, never
  from user input.

**Transport & response hygiene**

- helmet security headers, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on
  all API responses (personal data can't be cached by shared proxies), CORS locked to the
  two known origins with credentials.
- Swagger docs are disabled unless `SWAGGER_ENABLED=true`.

**Observability without leaking PII**

- Correlation ids on every request/response for tracing.
- Logs mask user ids and **redact query parameters** (mobile, email, token, reference,
  iccid, eid, …) so phone numbers never land in logs.
  → `apps/api/src/common/redact.ts`

**Audit trail** — staff actions (account type changes, invitations, reviews) write
`auditLog` rows; order timeline records every transition; provisioning attempts and
integration calls are recorded.

---

## 13. "Simulated vs real" cheat sheet

| Capability      | Simulated (dev)                                                                      | Real (production)                                           |
| --------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Accounts        | Clerk test app                                                                       | Clerk live                                                  |
| Payments        | `PAYMENT_MODE=simulator`, fake gateway, `simulate` endpoint                          | Khalti (`PAYMENT_MODE=sandbox` or production)               |
| eSIM activation | Needs Transatel **test** credentials; without them orders end in PROVISIONING_FAILED | Transatel live                                              |
| Inventory       | 20 mock eSIMs auto-seeded (non-prod only)                                            | Imported by ops via CSV/Excel                               |
| Documents       | Local "simulator" signed upload                                                      | Amazon S3 authenticated upload                             |
| Email/WhatsApp  | `NOTIFICATION_MODE=simulator` (no real send)                                         | Amazon SES / WhatsApp Cloud API                                 |
| Jobs            | In-process "fake" queue                                                              | BullMQ + Redis                                              |
| Persistence     | In-memory order map (lost on restart)                                                | PostgreSQL/Postgres via Prisma (`PERSISTENCE_MODE=prisma`) |

---

## 14. The biggest edge cases, all in one place

- **Order never paid** → stays PAYMENT_PENDING until ops expires it, customer abandons it
  (PAYMENT_FAILED), or cancels.
- **Payment verified twice** → second verify is idempotent (already COMPLETED).
- **Webhook replay** → deduped by event id; forged signature → rejected; forged-but-signed
  callback → re-verified against the real gateway anyway.
- **Two orders race for the last eSIM** → atomic reservation; loser gets a conflict error.
- **Provisioning fails 3×** → order PROVISIONING_FAILED; ops can retry (→ PROVISIONING).
- **QR arrives late** → Transatel webhook completes the order and emails the QR.
- **Customer uploads wrong document type** → verify rejects (PDF/JPG/PNG, ≤10 MB).
- **Document asked again** (REUPLOAD_REQUIRED) → only then can a document be changed;
  otherwise a submitted order is immutable.
- **Last super admin demoted/disabled** → refused (would lock the company out).
- **Partner accesses another partner's order** → 404 (tenant prefix mismatch).
- **Duplicate ICCID upload** → per-line error, not imported, batch still recorded.
- **Low stock** → dashboard warning; approval fails with "No eSIM inventory is currently
  available".
- **Plan deactivated mid-sale** → creation rejected.
- **Khalti returns wrong amount** → payment never confirmed (server checks).
- **Guest loses token** → 403 forever (no recovery by design).
- **Bootstrapped super admin tries to self-appoint in prod without the token** → blocked.

---

## 15. Where to look for what

| Topic                                           | File                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Order states & rules                            | `apps/api/src/modules/orders/order-machine.ts`                                                |
| Order logic (buy, docs, pay, provision, refund) | `apps/api/src/modules/orders/orders.service.ts`                                               |
| Guest checkout + tokens                         | `apps/api/src/modules/orders/guest-orders.controller.ts`                                      |
| Payments (simulator/Khalti)                     | `apps/api/src/modules/payments/`                                                              |
| eSIM inventory                                  | `apps/api/src/modules/inventory/inventory.service.ts`                                         |
| Transatel integration                           | `apps/api/src/modules/integration/transatel.provider.ts`                                      |
| Auth, roles, MFA                                | `apps/api/src/common/auth.guard.ts`                                                           |
| Rate limiting + client IP                       | `apps/api/src/common/rate-limit.guard.ts`, `guest-lookup.rate-limit.guard.ts`, `client-ip.ts` |
| Webhooks + signatures                           | `apps/api/src/modules/webhooks/webhooks.controller.ts`                                        |
| Background jobs                                 | `apps/api/src/jobs/`                                                                          |
| PII encryption                                  | `apps/api/src/infrastructure/crypto.service.ts`                                               |
| Shared schemas/contracts                        | `packages/shared/src/`                                                                        |
| Customer portal                                 | `apps/customer-web/src/app/`                                                                  |
| Ops portal                                      | `apps/ops-web/src/app/`                                                                       |
