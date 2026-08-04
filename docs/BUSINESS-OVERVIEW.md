# Visa Compass eSIM Platform — Plain-English Overview

*Written for business stakeholders and non-developers, with a few "behind the
scenes" notes for the technical readers. If you need every field, API, error
code and message spelled out, see
[`docs/PLATFORM-SPECIFICATION.md`](./PLATFORM-SPECIFICATION.md).*

---

## 1. What is this product?

Visa Compass sells **travel eSIMs**. An eSIM is a virtual SIM card: instead of
buying a plastic SIM at the airport, a traveller gets a QR code, scans it on
their phone, and instantly has mobile data in the destination country.

The platform is three websites working together:

1. **Customer website** — where travellers browse plans, upload documents,
   pay, and later download their eSIM.
2. **Operations website** — where the Visa Compass team manages eSIM stock
   ("inventory"), prices and plans, and handles exceptions (document
   replacements, failed activations). Orders are approved automatically once
   payment is verified.
3. **The API (engine room)** — a central service that connects everything:
   payments, the telecom provider, document storage, emails, and the database.

One customer journey: **browse → buy → verify → activate → use.**

---

## 2. The customer journey (step by step)

### Step 1 — Choosing a destination

The customer opens the website and picks a country (for example **UAE**).

**What happens:**
- The website shows every plan available for that country — data allowance
  (e.g. 5 GB), validity (e.g. 15 days), and price in NPR.
- The team can mark a plan as "popular" so it appears at the top.
- If no plans exist for a country, the customer is politely told coverage is
  not available yet.

*Behind the scenes:* the list of countries and plans comes from the database,
which is kept in sync with the telecom provider's official product catalogue
(either automatically or by an admin pushing a CSV). The customer only ever
sees plans marked "active".

### Step 2 — Compatibility check

Before buying, the customer must tick a box confirming their phone supports
eSIM and is carrier-unlocked.

**Why this matters:** an incompatible phone cannot use the eSIM, and there is
**no refund** in that case — so we record the customer's confirmation and
keep it as evidence.

*Behind the scenes:* the system stores a formal "consent record" (type, date,
IP address, browser details) for compliance.

### Step 3 — Traveller details

The customer enters their details **exactly as on their passport**:

- Title (Mr/Ms/Mrs), full name
- Date of birth, nationality, country of residence, city
- Email and mobile number
- Passport number and passport expiry date
- (Optional) employer/business name

*Behind the scenes:* sensitive fields (date of birth, passport number, expiry
date) are **encrypted** before being saved, so even someone with database
access cannot read them in plain text. The rules on each field are enforced
server-side (e.g. passport number 5–30 characters, dates must be valid).

### Step 4 — Uploading documents

Two documents are **required** — a **passport** and a **travel ticket**
(flight/ferry booking). A visa is optional.

**What happens:**
- The website securely uploads the files directly to a private document
  service (Cloudinary).
- The upload is "signed" — it is allowed only for a short window and only for
  this order — so customers cannot upload to the wrong place.
- Only PDF, JPG or PNG files up to 10 MB are accepted. Bigger or wrong-type
  files are rejected automatically.
- On a phone, the customer can also **take a photo** straight from the camera
  (e.g. a quick snap of their passport) instead of choosing an existing file.

### Step 5 — Payment

The customer chooses **Khalti** or **eSewa** (Nepal's digital wallets).

**What happens:**
- The customer is redirected to the wallet's page, pays, and returns.
- The system **double-checks** the payment with the wallet provider before
  accepting it: the order number, the reference, and the **exact amount in
  NPR** must all match. If the amount was tampered with (even by one rupee),
  the payment is not accepted.
- Once the payment is verified, the order is **automatically approved and
  sent for activation** — there is no waiting on a human reviewer.

*Behind the scenes:* if the wallet's confirmation is slow to arrive, the
website keeps quietly checking until the payment is verified (up to ~90
seconds). In development there is a fake "simulator" wallet so the whole flow
can be tested without real money.

### Step 6 — Automatic approval (reviews only for problems)

Orders are **approved automatically** as soon as the verified payment arrives.
A paid customer should never wait on manual review.

The human review step still exists, but only for **exceptions**:
- If a staff member later flags a document (blurry photo, wrong document, name
  mismatch), the customer is asked to upload a replacement. They see a
  "replacement document required" banner on their order page, and once they
  upload it the order returns to the review queue for a human to approve.
- Staff can still retry failed activations manually.

*Behind the scenes:* every decision (who approved, when, what was said) is
logged in an audit trail, and the customer never sees the reviewer's internal
ID.

### Step 7 — Activation (the exciting part)

Once automatically approved, the system:

1. **Reserves one eSIM from the stock** (inventory) — every profile can be
   used only once.
2. Asks the **telecom provider (Transatel)** to activate that eSIM for the
   customer's plan.
3. When the provider confirms and hands over the **QR code**, the order
   becomes "Completed".
4. Sends the customer an email: **"Your Visa Compass eSIM is ready"** with the
   QR code attached as a **password-protected PDF**.

If the provider is slow or fails, the system **tries again automatically**
(up to 3 times). If it still fails, the order is flagged for the team to
review or retry manually — the customer is told we are "reviewing it and will
contact them", not given a scary technical error.

*Behind the scenes:* activation is a background job — it does not block the
website. Every attempt (what was sent to the provider, what came back, the
error) is recorded so the team can investigate failures precisely.

### Step 8 — Using the eSIM

The customer opens the emailed PDF on their phone and enters the **mobile
number they used at checkout** when prompted. The PDF unlocks and reveals the
QR code, which they scan to activate the data plan at their destination.

- The QR is **not** shown in the customer account area — it is only ever
  delivered by email in the password-protected PDF, and the PDF password is
  the customer's own mobile number.
- The customer can still see a timeline of every step of their order.

### Step 9 — Usage (bonus)

For active subscriptions the system periodically checks with the provider how
much data was used and how much is left — so a "usage" feature is ready to be
surfaced to customers later.

---

## 3. What the business team can do

| Area | Capability |
| --- | --- |
| **Orders** | Dashboard with counts: awaiting review, awaiting customer documents, provisioning failures, completed today. Full order detail with document preview. |
| **Review** | Orders are approved automatically after verified payment. Review is used for exceptions only: approve replacement documents and retry failed activations. Every action is audited. |
| **Inventory** | See how many eSIM profiles are available/reserved/assigned/activated, low-stock warning (≤10), and **bulk upload stock from a CSV** (up to 5,000 profiles per file). |
| **Plans** | Edit prices, mark popular, enable/disable plans, and **bulk import/update the whole catalogue from a CSV** — changes go live to customers immediately. |
| **Integrations** | One screen showing whether each partner is connected (Khalti, eSewa, Transatel, email, WhatsApp, document storage), test each one, sync the Transatel catalogue, and check whether a number is eligible for a plan. |
| **Team & access** | Invite staff (invitation emails), assign Operations or Admin roles, disable users, and see the full audit log. |
| **Observability** | Log of every call to the telecom provider (and any inbound provider messages) with success/failure, so problems are diagnosed in minutes. |

---

## 4. The parts behind the scenes (and why they matter)

| Component | Plain-English role |
| --- | --- |
| **Sign-in (Clerk)** | Handles logins/passwords/MFA so we don't store passwords ourselves. Customer and staff are **separate accounts** — staff can never see the customer website as a customer and vice versa. |
| **Database (CockroachDB)** | The single source of truth: customers, orders, documents, payments, inventory, subscriptions, audit logs. |
| **Telecom provider (Transatel)** | The company that actually turns on the eSIM in the destination network. |
| **Wallets (Khalti/eSewa)** | Collect the money in NPR. |
| **Document storage (Cloudinary)** | Holds passport/ticket files privately, with short-lived access links. |
| **Email (Gmail) + WhatsApp** | Send order updates. The activation QR is delivered by email as a **password-protected PDF** (password = the customer's mobile number). |
| **Background jobs (Redis)** | A "to-do list" of tasks (activate this eSIM, verify this payment, send this email, refresh this usage). If a task fails it retries automatically. |
| **The audit trail** | An unchangeable diary of every important action (who invited whom, who approved what, who changed a price). |

---

## 5. Safety and trust features (worth telling customers and partners about)

- **Customer-safe error messages** — when something goes wrong, customers see
  simple, friendly text ("We could not activate your eSIM right now..."), never
  technical jargon or system details.
- **No leaking of internal data** — customers only ever see their own
  information; internal IDs, provider references and staff identities stay in
  the back office.
- **Exactly-once payments** — order number, reference and amount are all
  verified against the wallet before the order proceeds; the amount is frozen
  at purchase time.
- **Retries built in** — payment confirmations and eSIM activations retry
  automatically before ever bothering a human.
- **Duplicate protection** — the same provider message or the same "submit"
  click cannot be processed twice.
- **Rate limiting** — the website blocks spam/attacks (e.g. too many sign-in
  attempts per minute).
- **Encryption at rest** — passports and QR codes are stored encrypted.
- **Super Admin MFA** — the most powerful admin accounts must use two-factor
  authentication.

---

## 6. Partners (for other businesses selling eSIMs)

There is a ready-made **partner API** that lets approved partners (travel
agencies, etc.) sell Visa Compass eSIMs inside their own systems:

- Each partner has a secret key.
- They can fetch the plan list, get a price quote, create an order for a
  traveller, upload the same documents, accept payment, check connectivity
  status, pull usage, and trigger notifications.
- Partners can only see **their own** orders.
- All mutations require an idempotency key, so a partner retrying a request
  never creates a duplicate order.

---

## 7. The tech stack at a glance (for the technical reader)

| Layer | Technology |
| --- | --- |
| API | NestJS (TypeScript) |
| Customer portal | Next.js App Router (React) |
| Operations portal | Next.js App Router (React) |
| Shared contracts/validation | Internal `@visa-compass/shared` package (zod schemas, enums, error codes) |
| Database | CockroachDB via Prisma (enums, Decimal money, Json columns) |
| Background jobs | BullMQ on Redis (3 attempts, exponential backoff) |
| Auth | Clerk (JWT, authorized parties, MFA flag from session `fva`) |
| Payments | Khalti / eSewa adapters + local simulator |
| Connectivity | Transatel adapter (OCS preload, inventory, catalog, SIM management, webhooks) |
| Document storage | Cloudinary signed authenticated uploads |
| Notifications | Gmail API (OAuth refresh) + WhatsApp Business Cloud API |
| Security | helmet, CORS allow-list, rate limiting, AES-256-GCM at rest, HMAC webhook signatures, idempotency keys |

---

## 8. What is NOT finished yet (honest status)

- The three newest database migrations are written but **not applied** to a
  real database.
- Live credentials for Transatel, wallets, email and WhatsApp have **not been
  smoke-tested** — until then the ops dashboard shows them as
  "configuration required" and features run in **simulator mode**.
- The platform runs on a single server today; the rate-limiter and queue
  simulation are in-memory. For a multi-server production rollout, Redis and a
  shared database (both already supported) should be enabled.

---

*For the complete technical specification, error catalog, API reference and
field-by-field validation rules, open
[`docs/PLATFORM-SPECIFICATION.md`](./PLATFORM-SPECIFICATION.md).*
