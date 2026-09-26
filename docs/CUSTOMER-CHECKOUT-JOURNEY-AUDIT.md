# Customer checkout journey: screen and action audit

This matrix covers customer-facing direct guest (DG), direct account (DA), hosted-partner guest (HG), and hosted-partner account (HA) paths. Hosted pages retain partner identity, but the state meanings and gates must agree. Direct purchase is driven by `checkout-client.tsx`; hosted purchase by `hosted-checkout-client.tsx`. Recharge shares their payment stage and skips passport requirements. The older `07-order-lifecycle-flows.md` and `17-customer-web.md` describe an earlier payment-first flow, so the current components and API guards are authoritative here.

| Screen/state | Action | Expected result | Current handler / API | Next state and audit finding |
| --- | --- | --- | --- | --- |
| Catalog and plan selection (all) | Choose destination, search, select plan | Show the selected country's available plan and its real NPR price; retain the selected plan into checkout | Public catalog → `/esim/checkout?plan=…`; hosted link already snapshots a plan | Compatibility or recharge choice. Confirmed by catalog and checkout-entry tests; no checkout mutation on browsing. |
| Signed-in plan choice (DA) | Select an owned eSIM or buy new | Existing eSIM enters recharge; new purchase enters compatibility | `checkout-entry.tsx` → `/recharges/targets` | Target choice or compatibility. Guest cannot select an account-only target. |
| Compatibility (DG/DA/HG/HA) | Back, confirm device, accept terms, continue | Preserve consent on backward navigation; block continuation until required checks are accepted | Direct create `/customer/orders` or `/guest/orders`; hosted `/partner-checkout/:token/claim` for HA | Document stage for purchase, payment stage for recharge. No duplicate order on repeated clicks. |
| Account choice (DG/HG) | Continue as guest / sign in | Guest keeps private order access; account links the same order without changing price or partner attribution | Direct guest claim; hosted `POST /partner-checkout/:token/claim` | Documents/payment. Hosted access mode persists for same-tab refresh. |
| Documents (purchase) | Choose file, camera, replace, save | Upload only selected files; retain already confirmed documents; show save progress | Signed upload + confirm endpoints, then `verify-passport` | Full traveller form while OCR continues; invalid/rejected passport remains on documents with exact reason. Hosted immediate transition is a local, uncommitted change. |
| OCR pending | Enter traveller details / refresh | Show processing, preserve edits, prefill only empty fields when extraction arrives | Background OCR; order/session polling | Traveller form; never label pending OCR as awaiting human approval. |
| Traveller form | Back to documents | Navigation only; no automatic document mutation | Local step navigation | Documents with saved file summary and verification verdict retained. |
| Traveller form, verified and unchanged | Save and continue | Return directly to payment; no write, OCR, or loss of verdict | Previously always sent traveller mutation + `verify-passport`; now guarded by shared change classification | Payment. Regression tests cover all DG/DA/HG/HA paths. |
| Traveller form, contact-only edit | Save and continue | Save contact fields without restarting passport check | Direct/hosted traveller endpoint | Payment when verdict was verified; otherwise remain in current verification state. |
| Traveller form, passport identity edit | Save and continue | Invalidate prior automatic verdict and compare again; payment blocked | Direct `setTraveler`; hosted `setHostedTraveler` | Verified, mismatch, pending, or review. Hosted invalidation was missing and is addressed in this change set. |
| Mismatch | Edit only mismatched fields / save | Show extracted-versus-entered values for mismatched fields only; recompare saved correction | Direct/hosted traveller save + verify | Verified or mismatch/manual review. Other fields stay available for normal edit only outside comparison state. |
| Mismatch | “I checked—my details are correct” | Persist explicit confirmation, do not loop on unchanged compare | Direct/hosted `confirm-passport-details` | Dedicated manual-review tracking; payment blocked. |
| Manual review | View details, leave, return later | Read-only identity and automatic status refresh; no payment before ops approval | Order/session polling; account orders link where owned | Approval → payment; replacement → requested document screen. |
| Replacement requested | See ops reason, replace requested file | Show exact document and comment, retain unaffected uploads and original payment if already paid | Document recovery component + upload/confirm | Review resumes; paid order must not initiate another payment. |
| Payment choice | Back to documents, choose Khalti/Fonepay, continue | Back is navigation until provider initiation; amount and plan remain frozen | Direct and hosted payment handlers | Provider pending or gateway redirect. Once payment reference is live, editing is locked. |
| Provider pending/return | Check status, retry only if safe | Never create a second charge while prior attempt may settle; show expiry/retry reason | Payment verification and `paymentRetry` server declaration | Confirmed, safely retryable, or attention state. |
| Confirmed first purchase | View order / QR status | Receipt means payment received, not eSIM ready; notify and reveal installation QR only when provisioned | Shared `PaymentJourneyConfirmation` | Preparing → ready to install / attention. Guest delivery uses entered email; account uses My Orders. |
| Confirmed recharge | View my eSIM / track recharge | Say data is being added or has been added; do not promise a new installation QR | Shared confirmation in recharge mode | Added/active or attention. |
| Recovery/tracking | Copy private link, email link, refresh, view order | Guest token restores the same order; account owner uses My Orders; no PII is disclosed by recovery lookup | Guest recovery and hosted-token routes; account order pages | Correct saved stage, with no zero-price or lost-plan fallback. |

## Cross-path invariants and findings

1. **P1 — unchanged traveller resubmission:** Both direct and hosted forms called a write and passport check on an unchanged, verified order. A navigation-only fast path and server-side no-op are required.
2. **P1 — hosted identity edit after verification:** Hosted traveller save previously left the verified verdict intact. It must invalidate the prior passport decision before recheck, with payment still gated.
3. **P1 — premature hosted review copy:** A document-only `MANUAL_REVIEW` state can occur before traveller details are supplied. The document stage must say “add traveller details,” not imply the customer's work is complete.
4. **P2 — unexplained generic errors:** The standard checkout maps unrecognized API errors to “This request could not be completed.” The failing endpoint and correlation ID must remain discoverable; known conflicts should get a specific customer action.
5. **P2 — coverage gap:** Existing unit tests cover many isolated stages, but no single browser suite crosses all four access modes, reload/back, OCR delay, re-upload, and gateway return. Add deterministic mocked and API-level journeys, then run mobile and desktop projects.

## Evidence and verification

Review the two checkout clients, `checkout-resume.ts`, shared progress/recovery/confirmation components, `OrdersService`, hosted `PartnerService`, and their API controllers. Use parameterized frontend tests for mode parity; API tests for state guards; Playwright for navigation, focus, and mobile layout. Do not use real passport files or live payment in automated fixtures. For any unexpected production error, capture its endpoint, HTTP status, API code, and correlation ID without recording passport data or the private link.

### Run on 26 September 2026

- Shared, API, and customer-web typechecks passed. Focused shared/API/web suites cover unchanged submissions, contact-only preservation, identity invalidation, review/payment locks, and four-mode frontend back/forward behavior.
- The complete guest customer Playwright suite passed at desktop and mobile widths: **58 passed, 4 signed-in-only cases skipped**. Signed-in direct and hosted reopen/back/refresh scenarios passed in their isolated desktop/mobile projects: **4 passed**.
- The browser suite now covers inline catalogue recovery, document-stage layout, guest private-link restoration, signed-in order restoration, hosted delayed OCR, rejected ticket with its ops reason, and distinct paid first-purchase/recharge copy. The existing test drift (old selectors and dialog expectations) was repaired.
- Provider initiation, bank-app handoff, expiry/retry, notification delivery, and ops-side approval are still validated by API/component tests or require provider/sandbox integration; mocked Playwright responses cannot establish live gateway behavior.

### Release gate still open

The confirmed navigation and hosted re-verification gaps are fixed and the local customer browser suite is green. Do **not** infer live Khalti/Fonepay settlement, actual OCR accuracy, email delivery, or ops decisions from mocked browser tests. Those need production-like sandbox smoke tests with non-sensitive fixtures before release.
