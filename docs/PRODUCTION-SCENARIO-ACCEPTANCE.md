# Production scenario acceptance

This is the executable launch checklist for customer, guest, hosted-partner,
partner API, payment, inventory, Transatel, QR, refund, and infrastructure
failure paths. PostgreSQL is authoritative; queues and process memory are
recoverable coordination only.

## Implemented controls

| Risk                                           | Control and evidence                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment gateway is unreachable after expiry    | Attempts are persisted on `Payment.verificationAttempts`; exhaustion moves the order to `PAYMENT_REVIEW_REQUIRED` and creates `PAYMENT_UNCERTAIN` attention.                                               |
| Amount, currency, order, or reference mismatch | Confirmation fails closed and creates critical `PAYMENT_SECURITY` attention. Payment references are unique and atomically owned by one order.                                                              |
| Duplicate/concurrent confirmation              | A serializable database command claims `PENDING/REVIEW_REQUIRED → COMPLETED`; optimistic order versions and a stable provisioning job ID prevent duplicate fulfillment.                                    |
| Chargeback or dispute                          | A durable `PaymentDispute` stores provider case/event evidence, updates financial status, audits changes, and creates an Ops case.                                                                         |
| Safe stock disappears after payment            | The order remains recoverable in `PROVISIONING`, stock is never fabricated or force-restored, and `INVENTORY_SHORTAGE` attention is created.                                                               |
| Inventory reservation is abandoned             | A scheduled sweep releases only terminal-order reservations with no provider evidence; every uncertain reservation stays locked for reconciliation.                                                        |
| Expired/stale/unsafe inventory                 | Reservation atomically requires approved batch, fresh `available/allocated` provider state, no assignment, no subscription, and a future/no expiry.                                                        |
| Wrong ICCID or subscription callback           | The callback is retained in the inbox but rejected before inventory, subscription, operation, or order mutation; critical attention is created.                                                            |
| Out-of-order provider callback                 | Events that would regress `ACTIVATED` or a terminal provider state are ignored; terminal conflicts create attention.                                                                                       |
| QR delivered but activation is late            | The order moves to `ACTIVATION_ATTENTION`; QR and payment evidence remain valid while polling/Ops reconciliation continues.                                                                                |
| Refund is unresolved                           | Approved/requested refunds older than `REFUND_ATTENTION_HOURS` create actionable attention. Completion requires an external reference, exact amount, timestamp, audit, and an idempotent unique reference. |
| Scheduler or worker is unhealthy               | Platform health requires workflow, OCR, and reconciliation heartbeats and reports queue age, dead letters, unsafe stock, payment-review age, dispute count, and stuck lifecycle counts.                    |

## Automated evidence required on every release

Run API type-check/build and the failure-injection suites. The suites cover
persisted payment attempts, currency/reference mismatch, concurrent payment
claim semantics, last-stock eligibility, stale reservation release, dispute
idempotency, lost/won disputes, wrong provider identity, out-of-order callbacks,
activation attention, accepted-but-delayed provisioning, and inventory
shortage recovery.

Before enabling traffic, run the database-backed concurrency suite with two API
processes and two workflow workers against the release database and Redis. Kill
each process at DB-commit, enqueue, external-acceptance, and local-completion
boundaries. Replay duplicate and reversed callbacks and prove that no duplicate
charge, debit, inventory claim, provider subscription, refund, or destructive
Ops action occurs.

## External launch confirmations

The following cannot be proven by repository code and remain explicit go-live
gates:

- Khalti has confirmed callback retry timing, signature format, dispute events,
  and refund evidence/reference behavior for the production merchant account.
- Transatel has confirmed idempotency, lookup evidence, callback ordering, and
  suspend/terminate retry contracts for the assigned MVNO account.
- Product owners have published customer terms for incompatible devices,
  deleted eSIMs, shared/compromised QR codes, and post-activation termination.
- Operations alerts on reconciliation heartbeat age, queue age, webhook dead
  letters, payment review age, unsafe stock, and unresolved financial cases are
  connected to an on-call destination and tested.
