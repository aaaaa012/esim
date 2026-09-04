# Visa Compass — Production Test Case Matrix

Scope: full platform (API, customer-web, ops-web). Status per case reflects the automated suite
(`pnpm --filter @visa-compass/api test`, `@visa-compass/customer-web test`, `@visa-compass/shared test`)
plus the manual E2E scripts in §4 that must be executed against a deployed environment.

## 1. Automated coverage summary

| Area | Test file(s) | Cases | Status |
|---|---|---|---|
| Order state machine (legal transitions) | order-machine.test.ts | all transitions + illegal rejections | PASS |
| Provisioning retries / failover / race safety | orders-resilience.test.ts | 13 | PASS |
| Passport OCR + MRZ parsing | passport-verification.test.ts, mrz-parser.test.ts | field matching, confidence | PASS |
| Payments service (verify/reconcile/expiry) | payments.service.test.ts | double-charge guard, deferred verdicts | PASS |
| Khalti gateway (live money path) | khalti.gateway.test.ts | 10 — paisa math, status map incl. case-insensitivity, NaN-amount guard, 502 mapping, non-JSON rejection, header-secret hygiene, log-sink resilience | PASS |
| Payment simulator gateway | simulator.gateway.test.ts | sandbox flows | PASS |
| Manual refunds | manual-refunds.service.test.ts | approve/reject/complete guards | PASS |
| Webhook signature verification | webhooks.controller.test.ts | constant-time HMAC, replay of raw body | PASS |
| Inventory lifecycle + quarantine + failover reserve | inventory.service.test.ts | reserve/release/quarantine/batch approval | PASS |
| Transatel provider + operations | transatel.provider.test.ts, transatel-operations.service.test.ts, provider-failure.test.ts | preload commit point, delayed accept, outage handling | PASS |
| Notifications (service + templates) | notification.*.test.ts | queue-fail-closed, retry, branded HTML/text, QR credential secrecy, HTML escaping, personalization | PASS |
| Email channel (Amazon SES v2) | ses-email.channel.test.ts | 4 — simulation, UTF-8 text/HTML, attachment, reply-to, missing configuration, sanitized provider failure | PASS |
| Private storage (Amazon S3) | s3-storage.service.test.ts | 4 — simulation, content-type-bound presign, magic-byte verification, spoof rejection | PASS |
| Crypto (PII/QR encryption) | crypto.service.test.ts | roundtrip, per-call IV, GCM tamper detection, blind index normalization, prod fail-closed | PASS |
| Env validation (production gate) | env-validation.test.ts | 8 — missing secrets named, sandbox Khalti refused, localhost refused, multi-replica refused, provider-specific email creds | PASS |
| Partner channel (auth/hosted/prepaid/admin) | partner-*.test.ts | contract + idempotency + hosted checkout | PASS |
| Admin service, eSIM views, Clerk sync | admin/esims/clerk tests | role scoping, masked identifiers | PASS |
| Shared labels (UI wording) | packages/shared/src/labels.test.ts | no raw enums leak, QR_READY = "Ready to install" | PASS |
| Customer-web UI components | error-modal.test.tsx | a11y dialog, Escape/backdrop close, inner-click ignore | PASS |
| Ops-web UI | partner-workspace, lifecycle-actions tests | action gating | PASS |

Migration verification on 2026-08-28: **294 API + 7 customer-web automated
cases, all green**. Run the root suite to refresh the cross-workspace aggregate.

## 2. Critical edge cases covered by automation (auditor highlights)

1. Payment completed at gateway but callback lost → reconciliation recovers; never re-charges.
2. Provider accepted but response lost → ambiguous-outcome guard blocks duplicate provisioning.
3. Permanent SIM rejection → auto-failover to next profile; budget (default 2) persisted across restarts; exhausted → PROVISIONING_FAILED + ops alert.
4. Concurrent payment verification replacing in-memory order mid-provisioning → worker adopts live entry; DB and served state agree (QR race).
5. Tampered ciphertext (QR payload, passport fields) → GCM auth failure, no silent corruption.
6. Gateway returns unknown status → FAILED, never COMPLETED-by-default; missing amount on Completed → NaN → amount check fails closed.
7. Redis down → notifications marked FAILED loudly (never fake-SENT); webhooks buffered for replay.
8. Guest token: HMAC-signed, expiring, constant-time compared; expired/foreign tokens rejected.

## 3. Known untested surfaces (accepted risk, low blast radius)

- `main.ts` bootstrap retry loop (exercised only in real boots)
- `qr-pdf.service.ts` PDF bytes (manually verified in E2E; password = MSISDN)
- WhatsApp channel live call (simulated-mode logic tested via notification service)
- Live S3/SES calls against the production AWS account (covered by the go-live
  smoke tests; SDK behavior is mocked in unit tests)

## 4. Manual E2E scripts (run against the AWS deployment before opening traffic)

### E2E-1 Guest purchase — happy path
1. Open `https://<customer-domain>/esim` → select plan → compatibility check passes.
2. Fill traveler details with a real passport; upload passport + ticket images.
3. Pay via Khalti **live** sandbox→prod key; complete payment.
4. Expect: checkout page flips to QR panel ≤ 60s; email with branded HTML + attached QR PNG arrives; DB order = QR_READY; provisioning attempt 1, swapCount 0.

### E2E-2 Account purchase + install
1. Sign up via Clerk, buy a plan, open `/account/esims`.
2. Orders page shows "Ready to install" bucket (not Processing); dashboard hero shows Ready to install + Install button.
3. Install on a real device via QR modal; usage refresh returns balances after activation.

### E2E-3 Rejection failover (staging provider or forced bad ICCID batch)
1. Quarantine all but one known-bad profile; purchase.
2. Expect: automatic swap (timeline shows PROVISIONING→PROVISIONING), success on next profile, `profileSwapCount=1`.

### E2E-4 Failure & recovery paths
1. Force provisioning exhaustion → order PROVISIONING_FAILED, ops alert email received, inventory released.
2. Kill Redis mid-checkout → webhook buffered; restore → payment completes without user action.
3. Abandon Khalti payment → expiry reconcile marks FAILED; retry creates a new reference.

### E2E-5 Ops portal
1. Super admin logs into ops-web; verify orders work-queue, notification retry, integration logs show the Khalti/Transatel calls from E2E-1 with bodies.
2. Manual refund flow end-to-end.

### E2E-6 Security spot checks
1. Replay a Transatel webhook with a bad signature → 401/400, no state change.
2. Call `/api/v1/guest/orders/<id>` with an expired token → 403.
3. Rate-limit an auth endpoint past 60/min → 429.
4. Confirm Swagger (`/api/docs`) is NOT reachable when `SWAGGER_ENABLED` unset.

## 5. Regression command sheet

```bash
pnpm --filter @visa-compass/shared test
pnpm --filter @visa-compass/api test && pnpm --filter @visa-compass/api lint
pnpm --filter @visa-compass/customer-web test && pnpm --filter @visa-compass/customer-web typecheck
pnpm --filter @visa-compass/ops-web test && pnpm --filter @visa-compass/ops-web typecheck
```

## Cross-journey release gate

These scenarios are mandatory before a customer-facing or operations release.

| Journey | Required verification |
|---|---|
| Signed-in customer purchase | Compatibility and legal consent are independently required; traveller documents, payment, fulfilment and QR delivery complete. |
| Guest purchase and recovery | The same consent rules apply; recovery resumes only the bound order and never exposes another customer. |
| Hosted checkout | Initial purchase requires compatibility plus legal consent; recharge requires current legal consent without recollecting traveller documents. |
| Existing-eSIM recharge | Public MSISDN submission returns a uniform response; only the original purchase email receives a 15-minute signed link; tampered/expired links fail. |
| Payment recovery | Success, cancellation, pending, expiry and retry retain one order and one idempotent payment intent. |
| Staff lifecycle | Invitation, activation, sign-in, required password change, role checks and disabled-account handling use distinct states. |
| Operations fulfilment | Document review, order approval, provider status checks, provisioning retry and QR resend require explicit accessible confirmation. |
| Failure presentation | Unknown provider, Clerk and server errors render approved copy only; correlation IDs and provider detail remain in restricted logs. |
| Navigation failures | Signed-out routes go to sign-in, wrong roles to unauthorized, disabled users to account unavailable, and API outages to service unavailable with return destination preserved. |
| Application boundaries | Unknown URLs render 404; route errors offer retry; root failures render a safe global recovery page; loading states remain accessible. |

Automated release checks cover the consent contract, signed recharge-token integrity, error sanitization, auth-route classification, payment idempotency, checkout recovery, staff sign-in policy and role-based navigation. Environment-backed staging smoke tests must exercise Clerk, payment, email, object storage and Transatel integrations before production promotion.
