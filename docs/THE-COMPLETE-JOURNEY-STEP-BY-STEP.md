# The Complete Journey, Step by Step

*One document that walks the whole Visa Compass journey from the first visit to the
last — exactly as the current codebase works today. No technical jargon. Read it
from top to bottom like a story.*

*Who is in this story:*
- **The customer** — a traveller buying an eSIM.
- **The system** — Visa Compass software (the website, the engine behind it, and the
  automatic background chores it runs on its own).
- **The operations team** — the people at Visa Compass who watch and step in when
  needed.
- **External partners** — Khalti (the wallet that collects money), Transatel (the
  telecom company that switches on the eSIM), the email/WhatsApp services, and the
  document storage service.

---

## Stage 1 — Browsing (the customer arrives)

**Step 1. The customer opens the website.**
No login is needed. The home page shows destinations and plan cards, e.g.
"UAE Essential · 5 GB · 15 days · NPR 2,499". Popular plans appear first.

**What the system does behind the scenes:**
- It reads the plan list from the product database and shows **only plans marked
  Active** for **countries marked Active**.
- If a country has no plans yet, it politely says coverage is coming — it never
  invents plans.
- The catalogue is filled by the business: either the admin uploads a spreadsheet,
  or (when switched on) the system pulls the telecom company's real product
  catalogue automatically.

---

## Stage 2 — "Already have an eSIM?" (optional top-up)

**Step 2. An existing customer types their mobile number** into the "Already have a
Visa Compass eSIM?" box on the home page.

**What the system does behind the scenes:**
- It cleans up the number (ignores +977, a leading 0, spaces and dashes) and looks
  for a **completed** order that used that same number.
- If found, it shows that customer's **current plan, how much data is used, and when
  it expires**, and remembers the number in the browser.
- The plan cards now say **"Recharge"** instead of "Choose", and the number is
  carried into the next purchase so the system knows it is a **top-up**, not a first
  sale.

---

## Stage 3 — Checkout begins (choose a plan)

**Step 3. The customer presses Choose (or Recharge)** and reaches the checkout page.
The checkout is a simple wizard with **four steps in order:**

> **1. Compatibility → 2. Traveller → 3. Documents → 4. Payment**

**Step 4 (Wizard step 1) — Confirm the device.**
The customer ticks **"I confirm my device is compatible"** and notes that an
incompatible phone is not eligible for a refund.

**What the system does behind the scenes:** this confirmation is recorded as
evidence (with the browser type and location) — because a device that can't use an
eSIM is not refundable, the system keeps proof the customer agreed.

**Step 5 (Wizard step 2) — Traveller details.**
The customer enters their details exactly as on the passport: title, names, date of
birth, nationality, city, country of residence, email, mobile number, passport
number and passport expiry.

**What the system does behind the scenes:**
- Every field is checked before continuing (valid email, valid dates, two-letter
  country codes, etc.). Mistakes are blocked, not ignored.
- **Sensitive fields are encrypted** before saving (date of birth, passport number,
  passport expiry), so even a leaked database cannot be read in plain text.
- A scrambled, searchable fingerprint of the passport number is kept — one passport
  cannot be used to claim two refunds.

**Step 6 (Wizard step 3) — Travel documents.**
The customer uploads a **passport** and a **travel ticket** (a visa is optional).
PDF, JPG and PNG are allowed, up to 10 MB. On a phone there is also a
"Take photo" button for the passport.

**What the system does behind the scenes:**
- The upload is "signed" — a short-lived, order-specific permission, so a file can
  only go into this order's private folder and nowhere else.
- The file goes **directly and privately** to the document storage service, then the
  system checks it **actually arrived** before moving on.

**Step 7 (Wizard step 4) — Pay.**
The customer chooses **Khalti** (Nepal's digital wallet) and is sent to the wallet's
payment page. After paying, the wallet sends them back to the checkout page, which
keeps checking until the payment is confirmed (usually seconds).

**What the system does behind the scenes:**
- An order is created as soon as the first step is saved. The **price is frozen** at
  that moment — it cannot change mid-checkout.
- The payment reference and a **payment window** are recorded.
- When the customer returns, the system does a **double-check with the wallet
  before accepting anything**: the order number, the payment reference, and the
  **exact amount in rupees** must all match. If the amount differs by even one rupee,
  the payment is rejected.
- Every order gets an order number (e.g. `VC-2026-1A2B3C4D`) and a status that the
  system tracks from here to the end.

**What if the customer doesn't pay?**
- If they abandon the payment, the order is cleanly marked **Payment Failed** — it
  is never left stuck.
- If they just close the browser and come back later, they can resume exactly where
  they left off (the system remembers them via a secure, order-only token that is
  never shared with anyone else). Signed-in customers simply resume in
  "My eSIMs".

**Signed in or not?**
- A signed-in customer checks out with their account.
- A **guest** (no account) checks out the same way, login-free. Their order is
  guarded by a private token bound only to their own browser, so only they can
  continue it.

---

## Stage 4 — Automatic approval (no human needed)

**Step 8. The moment payment is verified, the order is approved automatically.**

**What the system does behind the scenes:** a paying customer should never wait for
staff. The instant the wallet confirms the payment, the order moves straight from
"Payment Confirmed" → "Approved" → "Activating" with no human in the middle. Staff
review screens still exist, but they are for **exceptions only** (see Stage 6).

---

## Stage 5 — Activation (the automatic magic)

**Step 9. The system switches the eSIM on.**
Behind the scenes, in order:

1. **Reserve one physical eSIM** from the company's stock. Every profile is used
   once and never reused.
2. **Ask the telecom company (Transatel)** to load the chosen plan onto that eSIM
   (the same plan the customer paid for, with its data and validity).
3. **Get the QR code** from the telecom company. This QR is the "key" that installs
   the eSIM on the customer's phone.
4. Mark the order **Completed**.
5. **Email the customer: "Your Visa Compass eSIM is ready"**, with the QR attached
   as a **password-protected PDF**.

**Step 10. The customer installs the eSIM.**
They open the emailed PDF on their phone, enter the **mobile number they used at
checkout**, and it unlocks to reveal the QR. They scan it — and they have data.

**What the system does behind the scenes (the safety nets):**
- The QR is **never shown on the website** — it only ever travels by email, locked
  with the customer's own mobile number.
- If activation fails, the system **tries again automatically, up to 3 times**.
- If it still fails, the order is flagged **for the operations team** and the
  customer is told the friendly message *"our team is reviewing it and will contact
  you"* — never scary technical text.
- In some cases the telecom company confirms activation a little later through a
  "callback" message. The system accepts that too: when the callback arrives it
  completes the order and emails the QR then.
- Every attempt (what was sent, what came back, the error) is **logged** so the team
  can diagnose problems precisely.

---

## Stage 6 — The quiet chores (no customer involved)

**Step 11. While the customer uses the eSIM, the system keeps checking data usage.**
Periodically it asks the telecom company how much data has been used and how much is
left, and keeps that fresh so the customer and the team can see it.

**Step 12. When the plan ends, the customer is told.**
When the **data is fully used up** or the **time has elapsed**, the system marks that
eSIM **Expired** and emails a friendly notice — *"your data plan was fully consumed"*
or *"your data plan has expired"* — which points them back to the top-up box. The
whole cycle can then start again at **Step 2**.

---

## Stage 7 — Refunds (a safety net)

**Step 13. Money can be returned when it should be.**
Refunds happen when a paid order cannot be delivered (for example, activation kept
failing) or when the team decides to reverse a payment.

**How it works:** a staff member clicks **"Refund order"** and gives a reason. The
order moves to *Refunding*, the system asks the wallet to return the money, and when
the wallet confirms, the order is marked **Refunded**. Every step is tracked and
audited. Only orders that were actually **paid** can be refunded, and every refund
needs a reason.

---

## Stage 8 — The operations team (watching and stepping in)

Everything above runs automatically. The team's job is to watch and to handle
**exceptions**:

| Area | What the team does |
| --- | --- |
| **Dashboard** | Sees at a glance: orders awaiting review, orders waiting on a customer, activation failures, and how many were completed today. |
| **Order list & detail** | Searches and opens any order; sees the full picture **including internal details staff need but customers never see**. Can see whether an order is a FIRST PURCHASE or a TOP-UP and the top-up number. |
| **Documents** | Previews the customer's uploaded passport/ticket and either **Approves** them or asks for a **replacement**. |
| **Replacement documents** | If a document is rejected, the order waits on the customer. The customer re-uploads it in "My eSIMs", and the order automatically returns to the review queue. |
| **Retry activation** | One click to retry a failed activation (after the automatic 3 tries). |
| **Refund / cancel** | Reverse a paid order or cancel a stuck draft — always with a reason, always audited. |
| **Payment cleanup** | One button to clear orders whose payment windows ran out. |
| **Inventory** | Sees how many eSIMs are available / reserved / assigned / activated, gets a low-stock warning, and uploads stock from a spreadsheet. |
| **Plans & prices** | Edits prices, marks plans popular, enables/disables plans, and imports/updates the whole catalogue from a spreadsheet — changes go live to customers immediately. |
| **Find a subscriber** | Types a mobile number to see its current plan and route future sales as TOP-UP. |
| **Integrations** | One screen showing whether every partner is connected (wallet, telecom, email, WhatsApp, storage), testing each one, pulling the telecom catalogue, and checking whether a number is eligible for a plan. |
| **Team & access** | Invites staff by email, assigns Operations or Admin roles, disables accounts, and reads the full audit log. |

---

## Stage 9 — The admin (super admin, inside the ops website)

- **Roles & access:** invite staff, change who is Operations vs Admin, disable
  accounts, review invitations. Safety rule: **the last remaining active super admin
  can never be removed or disabled**, and super admins are required to use
  **two-factor authentication**.
- **Audit trail:** an unchangeable diary of every important action — who approved
  what, who changed a price, who was invited. Nobody can alter it.

---

## Stage 10 — Partners (other businesses selling our eSIMs)

If a travel agency wants to sell Visa Compass eSIMs inside its own app, it gets a
secret key and a ready interface that lets it: fetch the plan list, create an order,
upload the same documents, accept payment, check order status and data usage, and
send notifications.

- Partners can **only ever see their own orders**, never anyone else's.
- Every repeated request is protected, so a retry can **never create a duplicate
  order**.

---

## The order's life at a glance (statuses the system uses)

| Status shown | What it means |
| --- | --- |
| **Draft** | Checkout started, not yet submitted (can be resumed or cancelled). |
| **Payment Pending** | Waiting for the customer to pay (has a time window). |
| **Payment Confirmed** | Money received and verified by the wallet. |
| **Approved / Activating** | Payment verified; an eSIM is being switched on automatically. |
| **Completed** | eSIM is ready; the QR was emailed. |
| **Payment Failed** | Payment did not go through; the customer can retry or cancel. |
| **Awaiting Customer** | Staff asked for a replacement document; waiting on the customer. |
| **Activation Failed** | Automatic tries ran out; flagged for staff to retry or refund. |
| **Refunding / Refunded** | Money is being (or has been) returned. |
| **Cancelled** | The order was stopped before payment completed. |

---

## Honest status (what is switched on vs. not yet)

**Everything described above is built and tested end to end.** To try it today:

- With the **simulator** payment (play money), a full purchase can be completed from
  "hello" to "QR emailed" without any real accounts.
- The real wallet (Khalti), the real telecom company (Transatel), real email/WhatsApp,
  real document storage, and real logins each need a **credential set** before a
  live customer can pay real money and receive a real QR. Until then, the features
  run in **simulator mode** and the integrations dashboard shows them as
  *"configuration required"*. This is the expected, normal state for a
  development-stage system — the code is all there; plugging in the real accounts is
  an operational step, not a development one.
- The newest **database changes** are written but not yet applied to a live database.
