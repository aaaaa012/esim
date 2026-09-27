# Visa Compass whole-system readiness audit

Date: 2026-09-10  
Mode: findings followed by verified code-level hardening  
Scope: customer web, Ops web, API, persistence, jobs, partner API, hosted
checkout, payments, Transatel, inventory, documents, notifications, security,
deployment, observability and business operations.

## Evidence and confidence

- **Confirmed** means directly demonstrated by code, schema, configuration or a
  repeatable automated result.
- **Probable** means the design has a concrete exposure, but production impact
  depends on traffic, infrastructure or provider behavior.
- **Certification gap** means repository code cannot prove the external fact.
- Unit evidence currently passes: API 480, customer web 132, Ops web 29 and
  shared 13 tests. All three application TypeScript checks pass.
- API build passes. Frontend compilation/type validation passes, but local
  prerender cannot finish without Clerk configuration.
- The responsive Playwright matrix was attempted during this audit and did not
  emit results before a five-minute runner timeout. Its prior JSON artifact is
  stale and also records infrastructure failure. Therefore this audit does not
  claim pixel-level approval of every route and viewport.

## Executive verdict

No confirmed code path was found that obviously permits an unauthenticated
customer to read another customer's order, a partner to read another partner's
records, or a duplicate verified payment to provision twice. The platform has
meaningful controls for ownership, amount/reference verification, optimistic
concurrency, idempotency, durable webhooks, queue recovery and provider-state
reconciliation.

Production signoff is nevertheless **conditional, not final**. There are no
newly confirmed P0 defects in this pass, but several P1 release blockers remain:
live provider certification is incomplete, browser evidence is not reliably
executable, operational data has no general retention policy, and the
single-host deployment has material blast
radius. Finance and legal requirements are also not complete enough for an
unqualified commercial signoff.

## P1: release-blocking observations

### R1. Provider behavior is contract-audited but not tenant-certified

- **Type:** Certification gap; high impact.
- Transatel suspension, reactivation, termination, usage, product preload,
  subscribe and callbacks are mapped deliberately, but account-specific OAuth
  scopes, idempotency, signature format, retry schedule and event ordering have
  not been proven with the production tenant.
- The prior Transatel datastream suspension is concrete evidence that this gate
  matters. A `202/204` from the ingress proves acceptance, not successful
  downstream state mutation.
- Required evidence: designated test ICCID/MSISDN, provider request IDs,
  callback delivery receipts, duplicate/reordered event tests and final-state
  comparison in both systems.
- **Owner:** Engineering + Transatel account manager + Operations.

### R2. Payment certification is incomplete

- **Type:** Certification gap; high financial impact.
- Khalti completion correctly depends on authoritative lookup and exact
  reference/order/currency/amount checks. However the custom signed webhook's
  production schema, signature, retry, refund and dispute semantics are not
  established by the public KPG-2 material.
- Fonepay uses WebSocket notification only as a signal and performs server-side
  status lookup, which is the safer model. Its merchant sandbox behavior,
  expiry, late success, reversal and settlement reporting still require proof.
- Required evidence includes browser closed after payment, callback absent,
  provider timeout after debit, late completion, amount mismatch, duplicate
  return, partial refund, chargeback and daily provider settlement comparison.
- **Owner:** Engineering + Finance + merchant-provider contacts.

### R3. Responsive and interaction evidence is not a reliable release gate

- **Type:** Confirmed test-infrastructure gap.
- Playwright defines 320px, mobile, tablet, laptop, desktop and wide-monitor
  projects, but E2E is absent from `.github/workflows/ci.yml`.
- The local responsive run timed out without producing current results. Existing
  artifacts are stale, so every-page claims would be unsupported.
- Coverage is also selective: public navigation and a few forms are exercised;
  it does not exhaustively execute every authenticated customer checkout state,
  every Ops table/dialog, every partner workspace tab or real Clerk flows.
- **Owner:** Frontend + QA + Release Engineering.

### R4. Transitive dependency advisories

- **Type:** Resolved after audit.
- Next.js was raised to 15.5.24 and the two critical findings were removed.
- Patched workspace resolutions were added for `nanoid`, `sharp`,
  `deepmerge-ts`, `multer`, and `qs`. Prisma generation, the API production
  build, and the full repository test suite pass on the installed graph.
- `pnpm audit --prod` now reports no known vulnerabilities, and CI blocks newly
  introduced high or critical production advisories.
- **Owner:** CTO/Security + Engineering.

### R5. Production data retention and deletion are incomplete

- **Type:** Confirmed operational/privacy gap; impact grows with time.
- Reconciliation deletes expired API idempotency records and stale unverified
  uploads, but no routine retention was found for `WebhookEvent`,
  `IntegrationLog`, `AuditLog`, `PartnerRateBucket`, old notifications or old
  operational events.
- Consequences include indefinite PII/identifier retention, database growth,
  slower Ops queries, larger backups and unclear privacy-compliance behavior.
- A policy must specify legal basis, retention periods, immutable audit needs,
  archival, erasure exceptions and deletion evidence.
- **Owner:** Legal/Privacy + Security + DBA + Operations.

### R6. Deployment remains a single-host, forward-only migration model

- **Type:** Confirmed resilience risk.
- CI deploys the tested commit to one EC2 environment. Application rollback is
  scripted, but database migrations are explicitly forward-only and are not
  reversed during rollback.
- A bad additive migration, host loss, disk pressure, security incident or
  incompatible app/schema rollback can affect all services together.
- Required proof: PITR, independent encrypted backup, restore drill, expand/
  contract migration policy, tested rollback-compatible releases, capacity
  alarms and documented host replacement.
- **Owner:** CTO/Platform/DBA.

### R7. Commercial finance requirements are under-specified

- **Type:** Requirement gap; potentially high legal/financial impact.
- Orders store subtotal/discount/tax/total fields, but no complete invoicing,
  VAT/tax determination, fiscal receipt, credit-note, provider-fee, payout or
  general-ledger export workflow was identified.
- Partner prepaid ledgers protect spendable cash, but Finance still needs a
  signed definition of revenue recognition, breakage/expiry, refunds,
  chargebacks, commissions, reconciliation tolerances and month-end close.
- **Owner:** Finance + Legal + Product + Engineering.

## P2: important operational and product gaps

### R8. Reactivation approvals have no expiry, rejection or cancellation path

- **Evidence:** Confirmed.
- The backend prevents self-approval and rechecks that the provider is still
  suspended before sending, so stale approval is fail-closed. However an
  `APPROVAL_REQUIRED` record can remain indefinitely and Ops can only approve
  it. There is no reject/cancel reason or approval SLA.
- **Resolved after audit:** requests now expire after a configurable 30-minute
  default, stale records are swept, and a different Super Admin can reject with
  a durable reason without making a provider call.

### R9. Requester identity is not used to prevent a futile UI action

- **Evidence:** Confirmed UX gap.
- The backend rejects self-approval, but the dashboard can still show the
  approval button to the requester. This is secure but creates avoidable error
  feedback and operational confusion.
- **Resolved after audit:** requester identity is returned to the dashboard and
  the requester sees an awaiting-another-admin state instead of decision controls.

### R10. “Check network status” is not a full business reconciliation

- **Evidence:** Confirmed semantics risk.
- It reads provider profile, subscriber and product/usage state and safely
  updates relevant records. It does not prove billing settlement, customer
  notification delivery, refund state, accounting state or device installation.
- Ops training must not treat a green provider status as an end-to-end order
  health certificate.

### R11. Suspension does not stop recurring package charges

- **Evidence:** Confirmed provider/business behavior.
- The UI now warns about this, but an operational policy is still needed for
  theft, fraud, temporary pause, customer-requested cancellation and recurring
  charge disputes. Suspend, cancel renewal, refund and terminate are different
  business actions and must not be used interchangeably.

### R12. Deleted profile and active subscriber can diverge

- **Evidence:** Confirmed domain possibility.
- The code now preserves separate profile, subscriber and package states and
  avoids falsely resurrecting a deleted profile. The remaining gap is a defined
  customer-resolution workflow: replacement eSIM, identity verification,
  entitlement transfer, residual allowance handling and cost ownership.

### R13. Webhook ingress depends on perimeter protection for volumetric abuse

- **Evidence:** Probable.
- Webhook routes bypass the global HTTP rate limiter because signatures are
  verified. This is reasonable for provider delivery, but an attacker can still
  consume connection, parsing and HMAC resources. WAF/body-size/source controls
  and provider retry-safe thresholds are required outside the application.

### R14. Partner IP allowlisting is not implemented

- **Evidence:** Confirmed and already documented.
- High-entropy bearer keys, scopes, status checks and database-backed rate
  limits are present. IP allowlisting is still a business/security decision,
  particularly for high-volume or financially privileged partners.

### R15. Partner rate-limit rows have no routine cleanup

- **Evidence:** Confirmed.
- A database row is created per partner/minute bucket. No scheduled deletion was
  found, so the table grows continuously even though old buckets have no runtime
  value.
- **Resolved after audit:** reconciliation deletes only expired technical
  buckets after a configurable 48-hour default.

### R16. Partner credential usage is not durably recorded per request

- **Evidence:** Intentional tradeoff.
- The guard avoids updating `lastUsedAt` to prevent write amplification;
  structured integration logs provide evidence instead. Incident response must
  confirm those logs are retained, searchable and exported before relying on
  them for credential-attribution or inactivity revocation.

### R17. Logging redaction is key-name based and cannot prove zero leakage

- **Evidence:** Probable.
- Strong recursive redaction exists for common secrets, PII, QR activation
  values and query strings. Unexpected provider fields, PII embedded in generic
  fields such as `detail`, or new keys outside the regex can still be persisted.
- Redaction regression fixtures should use real sanitized provider payloads and
  entropy/secret scanners, not only known field names.

### R18. Ops log success can mean “queued”, not “business applied”

- **Evidence:** Confirmed operational semantics.
- A Transatel callback log with HTTP 202/204 or result `QUEUED` records durable
  receipt. Processing can later fail, retry or dead-letter. Ops must correlate
  ingress, processor outcome, attention case and final entity state.

### R19. Manual refunds depend on off-platform provider execution

- **Evidence:** Confirmed product policy.
- Dual-control local evidence is strong, but the actual Khalti/Fonepay refund is
  manually performed and then recorded. Wrong reference, delayed recording,
  partial completion and provider rejection remain procedural risks requiring
  daily reconciliation and maker-checker evidence.

### R20. Fonepay lacks an application webhook/dispute channel

- **Evidence:** Contract-dependent gap.
- Current supplied material supports WebSocket signal plus status lookup, not an
  HTTP callback. A customer who closes the browser relies on backend polling/
  reconciliation. Reversals and disputes require an agreed alternate intake.

### R21. Inventory delivery model is still a contract decision

- **Evidence:** Certification/requirement gap.
- Visa Compass imports pre-provisioned inventory through approval-gated batches.
  Transatel also exposes reserve/release APIs. The current implementation is
  correct only if the commercial operating model is batch-delivered inventory.

### R22. Import replacement semantics need explicit operator acceptance tests

- **Evidence:** Requirement risk.
- Plan and inventory imports have approval gates and duplicate handling, but
  business owners should formally approve behavior for existing disabled plans,
  changed prices, removed products, duplicate ICCIDs, partial-invalid files,
  rollback and re-import after rejection. Spreadsheet behavior is a high-risk
  operational surface even when technically validated.

### R23. Document-verification policy still contains human judgement

- **Evidence:** Confirmed requirement gap.
- Upload validation, private storage and OCR failure states exist. The precise
  acceptable passport/visa/ticket combinations, transliteration, name variance,
  minors, dual nationality, unreadable stamps, expired documents and destination
  exceptions require an approved policy and sampled reviewer calibration.

### R24. Customer support and compensation rules are not system-complete

- **Evidence:** Requirement gap.
- The product needs explicit outcomes for incompatible phones, already-installed
  eSIMs, deleted profiles, QR compromise, no network at destination, partial
  usage, delayed activation, provider outage, duplicate purchase and abandoned
  payment. Technical attention states do not decide commercial compensation.

### R25. Notification delivery needs live channel evidence

- **Evidence:** Certification gap.
- Retry/deduplication logic exists, but sender reputation, SES production mode,
  bounce/complaint processing, attachment deliverability, WhatsApp configuration,
  recovery-link lifetime and multilingual rendering require live tests.

### R26. Metrics are process-local and require external aggregation

- **Evidence:** Confirmed.
- Counters reset on restart. This is acceptable only when Prometheus scraping,
  durable alert history and on-call routing are actually configured and tested.

### R27. Swagger exposure is configuration-sensitive

- **Evidence:** Confirmed controllable risk.
- Docs are exposed when `SWAGGER_ENABLED=true`. Partner docs intentionally show
  bearer shape and endpoints; production policy should decide authentication,
  network restriction and whether internal schemas are published.

### R28. CI secret scanning is narrow

- **Evidence:** Confirmed.
- The workflow grep checks only a small set of literal environment names. It is
  not a general secret scanner and Actions are referenced by mutable version
  tags instead of immutable commit SHAs.

### R29. CI does not run dependency audit, E2E, migration smoke or restore tests

- **Evidence:** Confirmed.
- **Partially resolved after audit:** CI now blocks high and critical production
  dependency advisories and applies every migration against disposable
  PostgreSQL before typecheck, unit tests, and builds. Browser journeys,
  multi-worker concurrency, backup restoration, and live provider certification
  remain separate release gates.

### R30. Documentation contains stale statements

- **Evidence:** Confirmed.
- `docs/20-documentation-gaps.md` still describes the HTTP limiter as purely
  per-process and `/auth/me` URLs as hard-coded; current code uses Redis when
  available and environment-derived URLs. Stale documentation can cause wrong
  operational decisions even when code is correct.
- **Resolved after audit:** the rate-limit, authentication-routing and protected
  metrics runbooks now match the implemented behavior and route prefix.

## UI/UX and accessibility observations

### R31. Current visual quality cannot be honestly called “perfect”

- Unit tests validate many state transitions and responsive-control classes,
  but they do not establish visual hierarchy, clipping, touch ergonomics,
  contrast or animation quality across every real data combination.
- Browser screenshots at all configured viewports, with long names, long plan
  titles, large currency values, empty/error/loading states and dense Ops rows,
  are still required.

### R32. Horizontal clipping rules may hide rather than solve overflow

- Both frontends use `overflow-x: hidden/clip` at shell or mobile boundaries.
  This prevents a visible page scrollbar but can conceal a child that is too
  wide. Browser assertions should inspect every element's bounding box, not only
  compare document scroll width.

### R33. Responsive tables need content-extreme testing

- Ops uses intentional table scrolling and nowrap controls. That is appropriate
  for operational density, but action buttons, UUIDs, email addresses, translated
  labels and large values must be tested at 320px and 200% zoom. The previously
  reported letter-by-letter button wrapping shows this is not theoretical.

### R34. Authentication coverage is uneven

- Clerk-backed sign-in, sign-up and recovery screens have component tests, but
  real OTP expiry, resend throttling, MFA enrollment/recovery, disabled sessions,
  multi-tab sign-out and identity-provider outage are not demonstrated end to
  end in this environment.

### R35. Refresh language and freshness indicators remain important

- In-place loading and saved-data reload labels are better than full-page flashes.
  Every screen that displays provider or payment state should still show whether
  it is locally stored, actively refreshing, last checked, stale, failed, or
  awaiting an asynchronous callback. “Refresh” must not imply a successful
  external mutation.

### R36. Accessibility evidence is partial

- Labels, roles, reduced-motion rules and named-control assertions exist.
  No automated axe/WCAG suite, screen-reader run, keyboard-only full journey,
  200/400% zoom audit, forced-colors test or contrast report was found.

### R37. Error recovery must be tested with preserved user input

- Many forms retain state and use dialogs/toasts, but exhaustive evidence is
  missing for every network timeout, expired session, duplicate submission,
  backward navigation and refresh point across guest, signed-in and hosted
  checkout. These should be scenario tests, not visual spot checks.

## Scenario observations by journey

| Journey            | Positive path                                          | Highest-risk negative/edge evidence still needed                                                |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Guest purchase     | Private recovery and verified payment flow exist       | Lost tab, expired recovery, duplicate return, payment succeeds after local timeout              |
| Signed-in purchase | Ownership isolation and account history exist          | Session expires mid-upload/payment, second tab edits same order                                 |
| Recharge/top-up    | Existing eSIM is reused; no new QR                     | Wrong MSISDN, transferred number, expired package, deleted profile, concurrent top-ups          |
| Hosted checkout    | Partner attribution with customer-funded payment       | Link expiry/revocation mid-flow, partner suspended, destination/price changed                   |
| Partner API        | Scoped key, idempotency, prepaid balance and ownership | Concurrent last balance, key rotation during retry, webhook endpoint outage, client conformance |
| Khalti             | Server lookup and exact value checks                   | Late success, undocumented callback, reversal, partial refund, settlement mismatch              |
| Fonepay            | Signed initiation and authoritative lookup             | Browser closed, WebSocket unavailable, reversal/dispute, merchant settlement mismatch           |
| Transatel preload  | Async provisioning and QR reconciliation               | Provider accepts then times out, mismatched identifiers, event before local commit              |
| Transatel top-up   | Subscription-specific state and usage                  | Old package expiry after new top-up, missing balance total, recurring renewal event             |
| Lifecycle          | Suspend/reactivate/terminate with reconciliation       | Stale approval, rejection/cancel, recurring billing, unexpected external admin action           |
| Documents          | Private upload verification and review                 | Malware, huge decompression, rotated/low-quality image, policy disagreement, erasure            |
| Notifications      | Queue, retry and dedupe                                | Bounce/complaint, expired link delivered late, attachment filtering, duplicate delivery         |
| Deployment         | Tested commit and health checks                        | Schema/app incompatibility, host loss, failed restore, secret rotation, partial rollout         |

## Required decisions before unconditional signoff

1. Approve the legal and operational retention schedule, including customer
   erasure and audit exceptions.
2. Approve tax, invoice, commission, settlement, refund, dispute and revenue-
   recognition rules with Finance signoff.
3. Confirm Transatel's batch-inventory operating model and certify all tenant
   endpoints/events with real test assets.
4. Obtain Khalti and Fonepay written merchant-contract confirmation and execute
   sandbox/production-like failure scenarios.
5. Decide partner IP allowlisting tiers and credential inactivity policy.
6. Define lifecycle approval expiry/rejection and the commercial meaning of
   suspension when recurring charges continue.
7. Make browser E2E, disposable-DB migration smoke, dependency audit and restore
   evidence enforceable release gates.
8. Approve recovery/compensation policies for deleted eSIMs, incompatibility,
   provider outage, delayed activation and partial service.

## Signoff by discipline

- **CTO/Architecture:** Conditional; core boundaries are credible, but topology,
  provider certification, schema rollout and release evidence remain open.
- **Security:** Conditional; good fail-closed and redaction practices, with
  unresolved dependency, retention, perimeter and CI supply-chain risks.
- **Product/Requirements:** Conditional; technical states are detailed, while
  several customer-remedy and lifecycle business rules need approval.
- **Finance:** Not final; prepaid controls are substantial, but fiscal documents,
  fees, settlement close, taxation and dispute operations need definition.
- **Operations:** Conditional; attention/reconciliation tooling is strong, but
  runbook drills, alert routing, lifecycle SLA and provider correlation must be
  proven live.
- **Frontend/UX:** Conditional; design language is coherent and many recovery
  states are tested, but full viewport, accessibility and real-data visual
  evidence is incomplete.
- **Business:** Conditional; launch readiness depends on documented SLAs,
  compensation policy, partner terms and provider commitments.

The appropriate conclusion is **controlled pilot after the P1 evidence gates,
not an unconditional “everything is perfect” declaration**.
