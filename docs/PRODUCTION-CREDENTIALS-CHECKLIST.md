# What We Need From You to Go Live (Credential & Setup Checklist)

This is the one-page list of **real (production)** accounts, passwords, and
infrastructure we need from the Visa Compass team before the app can take real
money and real customers live.

> Everything in this list is for **production only**. The app already runs for
> testing without these (it has safe "simulator" mode for payments, SIM
> provisioning, and notifications). These are the credentials we need to switch
> to real money / real services.

---

## 1. Real Accounts + Passwords (fill in values)

| What it's for | How it's used | Status |
| --- | --- | --- |
| **Clerk** keys | Customer logins (sign up / sign in) | ▢ Needed |
| **Khalti** (live) | Taking real card / wallet payment for eSIMs | ▢ Needed |
| **Cloudinary** keys | Secure storage of passport photos | ▢ Needed |
| **Transatel** (live) | The real SIM / data provider that delivers the eSIM | ▢ Needed |
| **Gmail** OAuth | Sending order / alert emails to customers & ops | ▢ Needed |
| **WhatsApp Business** | Sending order / status messages to customers | ▢ Needed |
| **Super Admin** email | The admin who approves plans, SIM batches, refunds | ▢ Needed |
| **Partner API keys** | Any outside partner that sells on our behalf (optional) | ▢ Optional |

---

## 2. Infrastructure (provide access)

| Item | Purpose | Status |
| --- | --- | --- |
| Production **server / hosting** | Where the app runs 24/7 | ▢ Needed |
| **Database** (CockroachDB) | Stores customers, orders, payments | ▢ Needed |
| **Redis** | Background jobs (OCR, provisioning, payments checks) | ▢ Needed |
| **Internet access** (egress) | Reach providers (Khalti, Transatel, OCR files) | ▢ Confirm allowed |

---

## 3. Decisions We Need Confirmed (check one each)

- **Payments:** switch to real money finally? → ▢ Yes / ▢ Still testing
- **Plans/SIMs:** load the real Transatel catalogue on startup? → ▢ Yes / ▢ No
- **Alert email:** who gets an email if a SIM provisioning or payment fails?
  → write address: __________________
- **Wrong-amount / failure handling:** approve the automated retry & refund
  policies described in the runbook? → ▢ Yes / ▢ No

---

## 4. DevOps To-Dos (our job, but needs their yes)

- ▢ Run the one-time database upgrade (`prisma migrate deploy`) at launch.
- ▢ Generate unique secrets (never reuse the sample values in `.env.example`).
- ▢ Set `NODE_ENV=production`, turn off test/simulator modes and API docs.
- ▢ Ship the OCR file OR confirm the server can reach the internet to fetch it.

---

## The two most important questions, in short

1. *"Is our production server allowed to reach the outside internet?"* — if
   **no**, passport OCR and calls to Khalti/Transatel will not work.
2. *"Who is the single owner of all the real login keys and passwords?"* —
   we need one trusted person / one secure secrets store.

---

## Status note

Everything else (the app logic, checking, background jobs, admin portal) is
**already coded and working in test mode**. The only missing pieces to go live
are the real accounts and passwords on this page.