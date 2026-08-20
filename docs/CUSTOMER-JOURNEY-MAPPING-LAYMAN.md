# Visa Compass — Whole System in Plain English (Journey Map)

_Read this if you are not a developer. It walks through everything a customer (and
staff, and partners) does, what the system does next, and why. It is ordered like a
story, so you can trace one order from "hello" to "my data ran out."_

---

## The short version

One customer journey: **browse → buy → verify → activate → use → maybe top up → maybe
get refunded.**

The platform is **three websites + one engine**:

1. **Customer website** — where travellers shop and check out (no login needed).
2. **Operations website** — where the Visa Compass team watches and fixes things.
3. **Admin website (part of ops)** — where a super admin sets prices, stock, and roles.
4. **The API (engine room)** — connects payments, the telecom company, email, storage,
   and the database, and runs background chores automatically.

Everything below describes what you see, and a "behind the scenes" note for each step.

---

## PART 1 — The customer journey (step by step)

### Step 1 – The customer comes to the website

**You do:** open the home page. No account required.

**You see:** a list of destinations and plan cards — e.g. "UAE Essential · 5 GB ·
15 days · NPR 2,499." Popular plans are marked.

**System does:** shows only plans the business marked "active." If a country has no
plans yet, it politely says coverage is coming.

**Behind the scenes:** the plan list comes from the database, which is kept in sync
with the telecom company's real product catalogue (automatically, or when an admin
uploads a spreadsheet). The customer only ever sees approved, active pricing in NPR.

---

### Step 2 – Top up (optional, for existing users)

**You do:** if you already bought a Visa Compass eSIM and want more data, you type
your **mobile number** into the "Already have an eSIM?" box on the home page.

**System does:** looks up your number, shows your **current plan, how much data you
used, and when it expires.**

**You do:** choose a plan to recharge. The plan cards show **"Recharge"** and your
number is remembered.

**Behind the scenes:** the system normalises your number (ignores +977, leading 0,
spaces) and searches completed orders for it. New purchases for that number are
flagged as a **"TOP-UP"** so staff can tell a first sale from a refill at a glance.

---

### Step 3 – Pick a plan and confirm your phone

**You do:** press **Choose** (or **Recharge**), then tick **"I confirm my device is
compatible."** If you are not signed in, that's fine — you can check out as a guest.

**System does:** starts a draft order for you at that price.

**Behind the scenes:** the system stores this "compatibility confirmation" (with your
IP and browser type) as evidence. Reason: if your phone can't use an eSIM, there is
**no refund** — so we record you confirmed it. The price is **frozen** from this
moment.

---

### Step 4 – Traveller details

**You do:** enter your details exactly as on your passport: name, date of birth,
nationality, city, email, mobile, passport number and passport expiry.

**System does:** checks every field (e.g. passport number length, valid dates, valid
email). It won't let you continue with a mistake.

**Behind the scenes:** the sensitive fields — **date of birth, passport number,
passport expiry** — are **encrypted** before saving, so even someone with the database
can't read them in plain text. A searchable fingerprint of the passport number is
kept to prevent one passport being used twice for refunds.

---

### Step 5 – Upload documents

**You do:** upload a **passport** and **travel ticket** (a visa is optional). On a
phone you can also just **take a photo** of the passport.

**System does:** checks the file type (PDF/JPG/PNG) and size (max 10 MB). Uploads go
straight and securely to private storage, then the system confirms the file actually
arrived.

**Behind the scenes:** the upload is "signed" — it's only allowed for a short window
and only for this specific order, so nobody can upload into the wrong place or someone
else's folder.

---

### Step 6 – Pay

**You do:** choose **Khalti** (Nepal's wallet). You're taken to the
wallet, pay, and come back. The website keeps checking until it's confirmed (usually
seconds).

**System does:** **double-checks** the payment with the wallet before accepting it:
the order number, the reference, and the **exact amount in NPR** must all match. If
the amount was changed even by one rupee, the payment is rejected.

**Behind the scenes:** there's a fake "simulator" wallet in development so the whole
flow can be tested with play money. A downside case: if a customer abandons payment or
the payment window expires, the system now cleanly marks that order **failed/cancelled**
instead of leaving it stuck forever — and a paid order that later needs to be reversed
can be **refunded** (see Step 12).

---

### Step 7 – Automatic approval

**System does:** as soon as payment is verified, the order is **automatically
approved** — no human needed. A paying customer should never wait on staff.

**Behind the scenes:** this is the difference from old flows: staff reviewing every
order was replaced by an automatic "paid → approved → go activate" path. The human
review screen still exists, but only for exceptions.

---

### Step 8 – Activation (the magic part)

**System does:**

1. Reserves **one physical eSIM** from the company's stock (each profile is used once).
2. Asks the **telecom company (Transatel)** to switch that eSIM on for the plan.
3. When the telecom confirms and hands over the **QR code**, the order is marked
   **Completed**.
4. Emails the customer: **"Your Visa Compass eSIM is ready"** with the QR as a
   **password-protected PDF.**

**If things go wrong:** the system **tries again automatically** up to 3 times. If it
still fails, it flags the order for staff and tells the customer a friendly
_"our team is reviewing it and will contact you"_ — never scary technical text.

**Behind the scenes:** activation is a background chore; it doesn't freeze the
website. Every attempt (what was sent, what came back, the error) is logged so staff
can diagnose failures precisely.

---

### Step 9 – Use the eSIM

**You do:** open the emailed PDF on your phone, enter the **mobile number you used at
checkout** when prompted, and it unlocks to reveal the QR. Scan it on your phone at
your destination — done, you have data.

**Note:** the QR is deliberately **not** shown anywhere on the website; it only ever
arrives by email, and its password is your own mobile number.

---

### Step 10 – While you use it (the quiet chores)

**System does:** periodically phones the telecom company to ask how much data you've
used and how much is left, and keeps that fresh.

---

### Step 11 – When your plan runs out or expires

**System does (automatic chore):** when your **data is all used up** or your **time
has elapsed**, it marks that eSIM **expired** and emails you a friendly notice —
_"your data plan was fully consumed"_ or _"your data plan has expired."_

**You do:** head back to the site, type your number into the top-up box, and grab a
new plan (Step 2). That new purchase is tagged **TOP-UP**.

---

### Step 12 – Refunds (a safety net)

**When:** if a paid order later can't be delivered (e.g. activation kept failing) and
the team decides to reverse it, or a customer cancels after paying.

**System does:** staff clicks **"Refund order"**, the order moves to _refunding_, the
system asks the wallet to return the money, and the order is marked **refunded**. Every
step is tracked.

---

## PART 2 — What the business / staff team can do (ops website)

| Area                     | What the team can do                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**            | See at once: orders awaiting review, orders waiting on the customer for a new document, activation failures, and how many completed today.                                                                                                                           |
| **Order list & detail**  | Search orders, open any order, see the full picture **including sensitive internal details staff need but customers never see.** See a **FIRST PURCHASE vs TOP-UP** badge and the top-up number. Click the customer's uploaded documents to preview or approve them. |
| **Review**               | Because payment gives auto-approval, staff review is for **exceptions only**: approve a replacement document a customer re-uploaded, and retry a failed activation.                                                                                                  |
| **Refund / cancel**      | Reverse a paid order or cancel a stuck draft — with a reason, and it's audited.                                                                                                                                                                                      |
| **Payment cleanup**      | One button to "expire stale payments" — clears orders whose payment windows ran out.                                                                                                                                                                                 |
| **Find a subscriber**    | Type a mobile number to see its current plan and route future sales as TOP-UP.                                                                                                                                                                                       |
| **Inventory**            | See how many eSIMs are available / reserved / assigned / activated; get a low-stock warning; upload stock from a spreadsheet (up to 5,000 at a time).                                                                                                                |
| **Plan & price control** | Edit prices, mark popular, enable/disable plans, and import/update the whole catalogue from a spreadsheet — changes go live to customers immediately.                                                                                                                |
| **Integrations**         | One screen showing whether every partner is connected (Khalti, the telecom, email, WhatsApp, storage), test each one, pull the telecom catalogue, and check if a number is eligible for a plan.                                                                      |
| **Team & access**        | Invite staff (by email), give them Operations or Admin roles, disable people, and read the full audit log.                                                                                                                                                           |
| **Observability**        | A log of every call to the telecom company (and every message the telecom sends back) with success/failure, so problems are diagnosed in minutes, not hours.                                                                                                         |

---

## PART 3 – Admin (super admin, part of ops website)

- **Roles & access:** invite new staff, change who is an Operations user vs an Admin,
  disable accounts, review invitations. The **last remaining super admin cannot be
  removed** (safety rule), and super admins must use **two-factor authentication**.
- **Audit trail:** an unchangeable diary of every important action — who approved
  what, who changed a price, who was invited. Nobody (even staff) can see customer
  internal IDs in a customer view.

---

## PART 4 – Partners (other businesses selling our eSIMs)

If a travel agency wants to sell Visa Compass eSIMs inside its own app, it gets a
secret key and a ready API:

- Fetch the plan list, ask for a **price quote**, create an order for a traveller,
  upload the same documents, accept payment, check status and data usage, and send
  notifications.
- Partners can **only see their own orders**, never anyone else's.
- Every repeat-click is protected, so retrying a request can never create a duplicate
  order.

---

## Part 5 – The parts behind the scenes (in one glance)

| Component                       | Plain-English role                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign-in (Clerk)**             | Handles logins/passwords/MFA. Customer and staff are **separate** — staff can never act as a customer and vice versa.                  |
| **Database**                    | The single source of truth for everything: customers, orders, documents, payments, stock, subscriptions, audit log.                    |
| **Telecom company (Transatel)** | The company that actually turns on the eSIM in the destination country.                                                                |
| **Wallets (Khalti)**            | Collect the money in NPR, and return it on refunds.                                                                                    |
| **Document storage**            | Holds passports/tickets privately with short-lived links.                                                                              |
| **Email + WhatsApp**            | Send order updates; the activation QR arrives by email as a password-protected PDF.                                                    |
| **Background jobs**             | A to-do list the machine works through on its own (activate now, verify now, email now, refresh usage now). Fails retry automatically. |
| **Audit trail**                 | An unchangeable diary of every important action.                                                                                       |
| **Guest checkout**              | Lets people buy without signing up; their order is guarded by a secret "token" so only their own browser can continue it.              |

---

## Part 6 – Where development stands (conclusion / honest status)

**What is fully built and working end to end:**

- The complete customer flow: browse → top-up lookup → guest or signed-in checkout →
  documents → pay → auto-approve → activate → QR by email → use → expiry notice.
- Login-free checkout with a secure access token.
- Top-up by mobile number, with the first-vs-top-up flag shown to staff.
- Payment handling that **never leaves orders stuck**: expired windows are cleared,
  failures are resolved, and paid orders can be refunded through the wallet.
- Automatic plan **expiry / data-exhaustion** detection with friendly email alerts.
- The operations and admin consoles: dashboard, order review, inventory upload,
  plan/price control, integrations screen, staff roles, audit log.
- A partner API for other businesses, plus usage reporting fixed to use the real eSIM.

**What is deliberately not switched on yet (needs real-world setup):**

- The newest **database changes are written but not applied** to a real database.
- **Live credentials** for the telecom company, wallets, email and WhatsApp have not
  been smoke-tested — until they are, the dashboard shows these as
  _"configuration required"_ and the features run in **simulator mode** (play money,
  fake email). This is normal and expected for a development-stage system.
- Some backgrounds chores run on a single server in memory; for production on many
  servers, a shared database and message queue should be enabled (both are already
  supported under the hood).

**In short:** every screen a customer and staff member touch, and every automatic step
between them, exists and is tested. What remains before "go live" is operational, not
development — plugging in the real external accounts and applying the database to a
server.
