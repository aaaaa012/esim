# Visa Compass — Source of Truth (how the code actually works)

This is the one document that describes **exactly what the running system does today**,
walking every user journey step by step in plain language. It is based on the code
(`apps/api`, `apps/customer-web`, `apps/ops-web`, `packages/shared`), not on the design
docs. Use it to confirm what you want before go-live, then flag anything you want changed.

---

## 1. The three pieces

| Piece                             | Port | Who uses it                         | What it does                               |
| --------------------------------- | ---- | ----------------------------------- | ------------------------------------------ |
| Customer website (`customer-web`) | 3000 | Everyone, no login needed to browse | Storefront, checkout, "My eSIMs" account   |
| Ops portal (`ops-web`)            | 3001 | OPS + Super Admin staff only        | Review orders, inventory, admin panel      |
| API (`api`)                       | 4000 | Both websites + partners + webhooks | All business logic, payments, provisioning |

There are **three account types**: `CUSTOMER`, `OPERATIONS`, `SUPER_ADMIN`.

- The **database is the boss** for who you are. Clerk (the login provider) only proves "this
  email/person logged in". It never grants access to admin screens.
- A **Super Admin can do everything an Ops person can do, plus the admin stuff** (plans,
  staff invites, inventory approvals, integrations, user management).
- An **Ops person can never see the Admin panel**, and a **customer can never open the Ops
  portal** (they get a blank page). Staff and customer identities are separate — one email
  cannot be both.

---

## 2. A brand-new visitor lands on the homepage

1. The visitor opens the customer website. The homepage loads from public API calls
   (`/api/v1/public/plans`, `/public/countries`, `/public/coverage/:country`) — **no login
   needed**.
2. They see:
   - A hero ("Land connected. Travel freely.").
   - **Popular destinations** with **country flags** (emoji flags shown next to each country
     and on each plan card).
   - A **"Choose your destination"** dropdown (flags included) showing every country that has
     at least one plan.
   - A **top-up box**: _"Already have a Visa Compass eSIM? Enter your mobile number to see your
     current plan and recharge it."_
   - Plan cards for the chosen destination: name, flag, data amount, validity days, NPR price,
     and a **Choose** button. Only plans with status `ACTIVE` are shown — anything `DRAFT`,
     `DISABLED` or `ARCHIVED` is invisible to customers.
   - A small **coverage note** per destination (green "Coverage available" or an amber
     warning like "Coverage is unavailable for this destination right now").

3. **Country flags are already implemented.** They are emoji flags derived from the country's
   two-letter code, shown in the destination dropdown and on every plan card.

---

## 3. Top-up lookup (before buying, no login)

- The visitor types a mobile number and presses **Check**.
- The website asks the public guest API: "is there a **completed** order whose traveller used
  this mobile number?" Numbers are normalised (spaces/dashes stripped, `+977` or `0` prefix
  accepted).
- If found: it shows the current plan, data used/total, expiry date, and says
  **"Recharge detected"**. The chosen destination is remembered for this browsing session and
  the plan buttons change to **Recharge**.
- If not found: it says no active eSIM was found and invites them to pick a destination for a
  new eSIM.

---

## 4. Checkout — guest mode (visitor is NOT signed in)

Anyone can buy without an account. This is a full, real purchase.

1. Visitor clicks **Choose** on a plan → `/esim/checkout?plan=<id>`.
2. Because they are not signed in, the site works in **guest mode**: it creates the order
   through a special guest route and the server hands back a **secret token** tied to that
   order (an HMAC signature). The browser keeps the token and sends it with every step. This
   is how the purchase stays locked to that one order without a login.
3. Steps shown (4 steps):
   - **Compatibility** — "Confirm your device". The visitor ticks "I confirm my device is
     compatible" (incompatible devices are not refundable).
   - **Traveller** — exactly as on the passport: title, name, date of birth, passport number,
     passport expiry, nationality, country of residence, city, email, mobile/WhatsApp, and an
     optional employer/business field.
   - **Documents** — **Passport** and **Travel ticket** are required; **Visa** is optional.
     PDF/JPG/PNG, max 10 MB, uploaded to the private document store (Amazon S3) using a
     short-lived signed upload, or to a local simulator when storage isn't configured. The
     server verifies the upload landed.
   - **Payment** — Khalti.
4. **The price is frozen when the order is created.** Order numbers look like
   `VC-2026-A1B2C3D4`.

**What a guest CANNOT do:** nothing after checkout depends on an account — but if they don't
sign in, the order lives only with its token, and "My eSIMs" is not available to them. If they
sign up later with the same email/mobile, their completed orders are matched by mobile number
for top-ups.

---

## 5. Sign-up / sign-in (Clerk)

- Customers sign up/in on the customer website using Clerk (email + password, and optionally
  MFA).
- The very first time a signed-in user calls the API, the server **synchronises the identity
  automatically** (creates the local user record). The account type is decided by these rules,
  in order:
  1. **Staff invite:** if there is an **unused, unexpired staff invitation** for that email,
     the person becomes `OPERATIONS` or `SUPER_ADMIN` (whatever the invite says). Staff
     accounts are always created by a Super Admin first (see §11) — there is **no public
     staff sign-up**; the ops sign-in page has no "create account" link.
  2. **Super Admin bootstrap:** if the email equals `BOOTSTRAP_SUPER_ADMIN_EMAIL` and there is
     currently **zero active Super Admin**, the person becomes `SUPER_ADMIN`. This is the only
     exception where a staff account starts from a public sign-up (used once, at launch).
  3. **Otherwise everyone is a CUSTOMER**, and a customer profile is created with a code like
     `VC-XXXXXXXX`.
- Signing up with an email that already has an account → the invitation route refuses
  (staff/customer identities must stay separate).

---

## 6. First purchase — the full journey after payment

1. Customer pays via Khalti (or the local simulator in development). Khalti redirects back to
   the checkout page with a reference number.
2. The server calls Khalti to confirm: **did the exact order, exact reference, and exact NPR
   amount get paid?** Only then is the payment accepted (`PAYMENT_CONFIRMED`).
3. **Important — this is how the code works today:** the moment payment is confirmed, the
   order is **automatically approved and starts activating** (`APPROVED → PROVISIONING`). It
   does **not** wait for an ops person to review the documents. The ops "Work Queue" review
   step only kicks in later if ops rejects a document and the customer re-uploads it.
4. The server hands the order to the **provisioning job** (background worker; if Redis isn't
   configured it runs inside the API process, retrying up to 3 times):
   - It **reserves one eSIM profile** from inventory (oldest `AVAILABLE` profile first —
     FIFO), calls the connectivity provider (Transatel), and **requires the activation QR
     back**.
   - On success the profile is assigned to the customer, the order becomes **`COMPLETED`**, and
     a **"Your eSIM is ready"** email is queued.
   - On failure after all retries the order becomes **`PROVISIONING_FAILED`**, an ops alert
     email is queued, and an ops person can press **Retry provisioning**.
5. **The QR delivery:** the customer gets an email with an **unencrypted PNG image** of the QR.
   No password or MSISDN is required to open the attachment. They
   open the PDF on their phone and type the eSIM number shown in the email, then scan the QR in
   their phone's eSIM settings.
6. The customer can also see everything under **My eSIMs** in their account: status, the full
   immutable timeline, documents, payment info, and — once activated — a **data usage bar**
   (used MB / total MB, last checked time).
7. A background **reconciliation job** runs every 15 minutes (configurable): it refreshes usage
   from the provider and when a plan expires or runs out it marks it expired and emails the
   customer (`PLAN_EXPIRED` / `PLAN_EXHAUSTED`).

### Notes about document verification in this flow

- **Documents are verified at upload time** (the file really landed, is the right size/format)
  and **payment requires that a traveller + passport + ticket already exist**.
- But in the normal flow **no human checks the photo contents before the eSIM activates**,
  because of the auto-approval above. This is the single most important behaviour to confirm
  before go-live (see §14).

---

## 7. Top-up (recharging an existing eSIM)

- From the homepage top-up box (guest) or by choosing "Recharge" on a plan, the checkout
  becomes a **top-up**: no compatibility step, no traveller form, no documents — **pay and
  activate in seconds**.
- The order is flagged `TOP-UP` and remembers the mobile number.
- On activation the system tries to **reuse the same physical eSIM** from the previous
  completed order **when the destination country matches** (so one eSIM/profile just gets a new
  plan). If it can't (different country or no profile on file), it uses a fresh inventory
  profile.

---

## 8. Payments, failures, cancellations, refunds

| Situation                                                                | What happens                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Payment window expires (still `PAYMENT_PENDING` past the gateway expiry) | Ops (or the admin panel button) runs **"Expire stale payments"** → order becomes `PAYMENT_FAILED` ("Payment window expired") |
| Customer abandons payment                                                | Order becomes `PAYMENT_FAILED` with the given reason                                                                         |
| Customer cancels a draft / unpaid order                                  | Order becomes `CANCELLED` (also possible from ops portal)                                                                    |
| Ops refunds a **paid** order                                             | Dual control: Ops requests, Super Admin approves, staff refunds through the original provider, then Super Admin records exact amount/time/reference; only then payment and order become `REFUNDED` |
| Payment is still being confirmed after redirect                          | The checkout page polls the order until it settles (up to ~90 seconds), then shows the result                                |

Only orders in `DRAFT`, `PAYMENT_PENDING` or `PAYMENT_FAILED` can be cancelled. Refunds only
apply to paid, non-refunded orders.

---

## 9. The Ops portal (staff)

Anyone with `OPERATIONS` or `SUPER_ADMIN` type can sign in. **Customers get a blank page.**

Sidebar (all staff): Dashboard, Work Queue, Orders, Customers, Inventory, Notifications,
Integration Events, Audit Log.
Sidebar (Super Admin only): the **Administration** item appears.

- **Dashboard** — counts: pending reviews, awaiting customer, provisioning failed, completed
  today; integration health (Transatel / Khalti); recent orders.
- **Work Queue** — orders needing attention: `REVIEW_PENDING`, `AWAITING_CUSTOMER`,
  `PROVISIONING_FAILED`.
- **Orders** — searchable list; clicking an order opens the review page showing traveller
  details, the documents (with **Preview** — streamed from private storage, never cached),
  and the immutable timeline. Decision panel:
  - **Approve & provision** — only enabled after both **Passport and Ticket are individually
    approved**. This is the manual-review path used after a re-upload.
  - **Re-upload** — marks the document `REUPLOAD_REQUIRED`, moves the order to
    `AWAITING_CUSTOMER`, emails the customer to supply a better document; when they re-upload,
    the order comes back to `REVIEW_PENDING` automatically.
  - **Retry provisioning** — after `PROVISIONING_FAILED`.
  - **Refund order** (paid orders), **Cancel order** (draft/unpaid).
- **Customers** — grouped view of customers with their orders, completed eSIMs, and last order
  date; drill into a customer profile with orders, eSIM ICCID/status/expiry, and usage.
- **Inventory** — stock overview, **pending batches** with **Approve/Reject buttons visible
  only to Super Admin**, and imports (paste ICCIDs or CSV/Excel).
- **Notifications** — notification log, **retry** a failed one, and (Super Admin only) **Test**
  a notification.
- **Integration Events / Audit Log** — read-only history of provider events and every
  sensitive action (who did what).

### How inventory works (important for ops)

- Imported SIM profiles land in a `PENDING` batch with rows in `IMPORTED` state. **Nothing is
  sellable yet.**
- A **Super Admin must approve the batch** → rows become `AVAILABLE`. Rejecting leaves them
  withheld forever.
- When an order provisions, the system picks the **oldest `AVAILABLE` profile** (FIFO) and
  marks it `RESERVED`, then `ASSIGNED` once the customer's eSIM is created.
- If there are **no `AVAILABLE` profiles**, provisioning fails with "No eSIM inventory is
  currently available".

---

## 10. The Administration panel (Super Admin only)

- **Plans / Pricing** — see every plan (cost price, selling price, currency, status, popular),
  upload a CSV/XLSX to import plans (they land as `DRAFT`), **Approve** a draft (becomes
  `ACTIVE` and visible to customers), **Reject** (archived), edit the selling price, toggle
  popular, and change status.
- **Integrations** — live health of email, Khalti, Transatel, Amazon S3, WhatsApp; "Test"
  buttons; Transatel actions (**Sync catalog**, **Register webhook**, **Eligibility check** for
  a subscriber number); integration call log. Credentials are never shown — the UI explains how
  to set them in the environment.
- **Document Rules / Inventory Settings / System Config** — read-only business rules plus two
  ops tools: **look up a subscriber by MSISDN** (detect an existing eSIM so future purchases
  become top-ups) and **expire stale payments**.
- **Users** — invite staff (email + choose `OPERATIONS` or `SUPER_ADMIN`), see pending invites,
  and manage users: change status (`ACTIVE`/`DISABLED`) or change account type
  (`OPERATIONS`/`SUPER_ADMIN` only — customers can never be converted). The system **refuses to
  disable or demote the last active Super Admin** (prevents locking everyone out).
- **Pending staff invitations** expire after 90 days.

---

## 11. How staff accounts are created (the full chain)

1. A **Super Admin** opens Administration → Users, enters a **separate staff email** that must
   end in `@STAFF_EMAIL_DOMAIN` (default `@visacompassnepal.com`) and picks `OPERATIONS` or
   `SUPER_ADMIN`, then clicks **Invite staff**.
2. The server **pre-provisions the account**: it creates the Clerk user with a generated
   **one-time password**, stores a pending `StaffInvitation` row, and shows the one-time
   password to the Super Admin to hand over securely. **No invitation email is sent and the
   staff member does not sign up themselves.**
3. The staff member simply **signs in** on the ops portal (port 3001) with that email and the
   one-time password. They should change the password after first sign-in.
4. The first time their identity reaches the API, the server matches the pending invite by
   email, creates the account with the invite's role, marks the invite `ACCEPTED`, and writes
   an **audit log** entry.
5. Revoking a pending invite **deletes the Clerk user** (and disables any local record). Ops
   can invite more ops; **only Super Admin can invite or change Super Admins.**
6. There is **no public staff sign-up**. The ops `/sign-up` page exists only for the one-time
   Super Admin bootstrap; the sign-in page has no "create account" link, and a non-bootstrap
   sign-up is treated as a customer identity that cannot access the console.

### How the very first Super Admin is created

- Set `BOOTSTRAP_SUPER_ADMIN_EMAIL` in the environment. When **no active Super Admin exists
  yet**, the person who registers that exact email automatically becomes Super Admin. (In
  production this also requires `BOOTSTRAP_SUPER_ADMIN_TOKEN` to be set — see §14, it is only
  checked for being present, its value is never verified.)
- If a customer account already exists for that email and owns **no** orders/eSIMs, it is
  converted in place (customer row deleted, role becomes Super Admin). If it already owns
  business records, it is left a customer and an audit note is written telling you to use a
  separate staff identity.

---

## 12. What the customer sees in their account

- **My eSIMs** (`/account/esims`) — filter chips: **Ready** (completed), **Processing**
  (paying/reviewing/activating), **Needs action** (draft, needs re-upload, payment failed).
- **Order detail** — status chip, order number + date, order total, the full event timeline,
  each document with its status, a **"Resume checkout"** banner for incomplete orders, and the
  **eSIM activation card**: after completion it explains the emailed QR image, and
  shows the data usage bar; when a replacement document is needed it shows a banner and upload
  buttons.
- **Notifications** — the notification history for their orders.
- A customer cannot open the ops portal, and staff cannot open customer account pages.

---

## 13. Everything behind the scenes (security recap)

- **Public, no login:** homepage, plans, countries, coverage, guest top-up lookup, health,
  metrics.
- **Guest orders:** each order guarded by its HMAC token (in the browser's session storage).
- **Customer endpoints** (`/customer/*`): Clerk login + `CUSTOMER` type only.
- **Ops endpoints** (`/operations/*`): Clerk login + `OPERATIONS` or `SUPER_ADMIN`. Batch
  approve/reject and notification "test" are **Super Admin only**.
- **Admin endpoints** (`/admin/*`): **Super Admin only.**
- **Partners** (`/partners/*`): API key (SHA-256 hashed) via `x-partner-api-key`. Partner
  orders are isolated under `partner:<id>:<externalCustomerId>`.
- **Webhooks**: Clerk uses Svix signatures; Transatel uses `x-tsl-signature-256`; the payment
  callback uses a signature (mandatory in production).
- **Super Admin MFA is enforced by default** (`ENFORCE_SUPER_ADMIN_MFA=true`): a Super Admin
  without a second factor verified is redirected to the security page in the ops portal and
  blocked from admin + ops API calls until they enable MFA.

---

## 14. ⚠️ Things to explicitly confirm before go-live

These are **current behaviours** you should consciously accept or change:

1. **The ops document review is NOT a mandatory gate for normal purchases.**
   After payment, orders auto-approve and provision without a human looking at the documents.
   The review screen only matters for rejected/re-uploaded documents. If you want every new
   purchase reviewed by staff before activating, that needs a code change (route paid orders to
   `REVIEW_PENDING` instead of auto-approving).

2. **`BOOTSTRAP_SUPER_ADMIN_TOKEN` is only checked for being present — its value is never
   verified.** The real protection is that you control the bootstrap email and it only works
   while there are zero active Super Admins. **Recommended:** delete
   `BOOTSTRAP_SUPER_ADMIN_EMAIL` from the environment the moment the first Super Admin exists,
   so nobody else can ever bootstrap again.

3. **The last active Super Admin can lock the platform out from the outside.** The admin UI
   refuses to disable/demote the last Super Admin, but if the last Super Admin deletes their
   own Clerk account, the webhook disables them without the guard, leaving zero Super Admins
   (bootstrap would then re-open).

4. **Payment mode matters.** In production the Khalti gateway is used regardless; the payment
   simulator is disabled in production. Choose Khalti sandbox vs live via
   `KHALTI_BASE_URL` / `KHALTI_SECRET_KEY`.

5. **Provisioning depends on inventory.** Approve your SIM-profile batches in the ops portal
   (Super Admin) **before** customers buy — otherwise purchases fail with "No eSIM inventory is
   currently available".

6. **Top-up reuse is country-specific.** The same eSIM profile is reused for top-ups only when
   the previous order's country matches the new plan's country; otherwise a fresh profile is
   used.

7. **Guest purchases leave no account.** If a guest buys without signing up, their completed
   order is found later only via mobile number (for top-ups) or by the token in that browser.

8. **Notifications need real providers in production** (Amazon SES for email, optional
   WhatsApp). Without them, email delivery is simulated and the customer will **not** receive
   the QR attachment.

---

_This document mirrors the code as of go-live. If you change any behaviour, update this file so
it stays the single source of truth._
