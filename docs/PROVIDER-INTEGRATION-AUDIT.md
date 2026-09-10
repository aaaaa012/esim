# Provider integration release audit

Reconciled with the implementation on 2026-09-08 against the public Transatel
OpenAPI documents (OCS subscriptions 1.85, catalog, inventory and SIM
management), Khalti KPG-2 documentation, and the supplied Fonepay Intent Flow
v1.10 material.

## Identifier contract

| Identifier              | Meaning                                    | Valid shape                                   | Where it is used                                                                                                                                         |
| ----------------------- | ------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSISDN                  | Transatel subscriber/mobile network number | 6-15 digits, international format without `+` | OCS product orders (`bind.msisdn`), catalog eligibility (`?msisdn=`), OCS inventory/usage (`?msisdn=`), webhook `body.msisdn`                            |
| ICCID / `simSerial`     | Physical SIM/eSIM profile serial           | 13-20 digits                                  | SIM-management details (`/api/esims/sim-serial/{simSerial}`), connectivity-management lifecycle URLs, webhook `body.iccid` or lifecycle `body.simSerial` |
| EID                     | Device eUICC identifier                    | exactly 32 digits                             | eSIM allocation/release only; local target matching where supplied. Never used as an OCS subscriber identifier                                           |
| Product subscription ID | One subscribed plan/package                | provider string/UUID                          | Stored per order and per `Subscription`; correlates each top-up package and its events                                                                   |
| Product ID              | Catalog plan reference                     | provider catalog identifier                   | `product.productId` in preload/subscribe orders                                                                                                          |
| Transaction reference   | Visa Compass order/operation identifier    | <=255 characters                              | Sent to Transatel for reconciliation and webhook correlation                                                                                             |

An ICCID must never be substituted for `bind.msisdn` or an OCS inventory
`msisdn` query. One ICCID can have multiple product subscription IDs after
top-ups, so the inventory row is not the authoritative owner of every package.

## Transatel command matrix

| Business action        | Provider request                                                                                                       | Local behavior                                                                                       | Audit result                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Initial purchase       | `POST /ocs/subscriptions/api/orders/products`, `orderType=preload`, real MSISDN                                        | Persist provider acceptance before QR lookup; fetch QR using ICCID                                   | Aligned                                                                             |
| Top-up                 | Same endpoint, `orderType=subscribe`, real MSISDN                                                                      | Treat `201`/`done` as package commit; reuse existing eSIM QR record; do not request or send a new QR | Corrected in this audit                                                             |
| Eligibility            | `GET /ocs/catalog/api/cos/{cosRef}/products/{productId}?msisdn=...`                                                    | Honor `canSubscribe.allowed`; retain provider code internally and return safe copy                   | Aligned                                                                             |
| Usage                  | `GET /ocs/inventory/api/subscriptions/products?msisdn=...&withBalances=true`                                           | Aggregate non-terminated KB balances by product subscription                                         | Corrected: ICCID fallback removed                                                   |
| eSIM details           | `GET /sim-management/sims/api/esims/sim-serial/{iccid}`                                                                | Retrieve profile state and activation material                                                       | Aligned                                                                             |
| Subscriber suspension  | Tenant connectivity-management `.../sim-serial/{iccid}/suspend`                                                        | Audited, idempotent command; pending until provider confirmation                                     | Needs tenant-contract/live certification                                            |
| Subscriber termination | Tenant connectivity-management `.../sim-serial/{iccid}/terminate`                                                      | Super-admin-only irreversible action; pending until confirmation                                     | Needs tenant-contract/live certification                                            |
| Catalog sync           | `GET /ocs/catalog/api/cos/{cosRef}/products`                                                                           | Imports available one-off products and converts provider pricing/allowance units                     | Aligned; commercial FX/margin approval required                                     |
| Webhooks               | Configure a datastream in the Transatel Developer Console; signed raw-body inbox with durable dedupe/retry/dead-letter | Maps lifecycle events without state regression; deprecated API registration action removed           | Payload/signature and Console event selection must be certified with tenant samples |

Transatel also publishes SIM reserve/release endpoints. Visa Compass currently
uses approved inventory batch imports instead. This is complete only if the
contracted operating model is pre-provisioned inventory delivery; if Transatel
expects just-in-time reservation, reserve/release must be implemented.

## Status handling

| External state/event       | Local package/inventory effect                                   | Order effect                                                                             |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OCS `done` for `preload`   | Provider reference saved; wait for QR/activation                 | Remains `PROVISIONING`, then `QR_READY`/`COMPLETED` through activation                   |
| OCS `done` for `subscribe` | New `Subscription` linked to the existing physical eSIM          | Top-up becomes `COMPLETED`; no new QR                                                    |
| PRELOADED                  | Package pending; cannot regress active/terminal state            | No completed order regression                                                            |
| ACTIVATED                  | Inventory activated; package active; dates and identity verified | Completes initial provisioning when activation material exists                           |
| SUSPENDED subscriber       | Network service stops; package status remains independent        | Confirms an approved lifecycle operation; unexpected suspension opens critical attention |
| CANCELED                   | Stops future renewal but preserves service until expiration      | Order history retained                                                                   |
| EXPIRED product            | Only the matching package expires; the reusable eSIM remains     | Purchase history retained                                                                |
| TERMINATED product         | Only the matching package becomes terminal                       | Purchase history retained                                                                |
| TERMINATED subscriber      | Subscriber and eSIM inventory become terminal                    | Confirms approved termination or opens critical attention                                |
| Unknown/out-of-order       | Raw event retained; no unsafe mutation                           | Attention or ignored regression, never guessed                                           |

## Khalti KPG-2 matrix

| Action                      | Contract                                                                 | Audit result                                                                                                |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Initiate                    | Server `POST /api/v2/epayment/initiate/`, NPR converted to integer paisa | Aligned                                                                                                     |
| Customer return             | Browser GET return is only a signal                                      | Aligned: server performs lookup before service                                                              |
| Lookup                      | Server `POST /api/v2/epayment/lookup/` using `pidx`                      | Aligned: only `Completed` confirms payment; exact amount is checked                                         |
| Pending/Initiated           | Hold and recheck                                                         | Aligned                                                                                                     |
| Unknown future status       | Hold for review                                                          | Corrected; no longer falsely failed                                                                         |
| Expired/User canceled       | Do not provide service                                                   | Aligned                                                                                                     |
| Refunded/Partially refunded | Do not provide new service                                               | Parsed; post-completion monitoring needs operational reconciliation                                         |
| Refund policy               | Manual provider action with dual-control local evidence                  | Intentional: request, Super Admin approval, external completion, then exact amount/time/reference recording |

Public KPG-2 documents a browser return plus authoritative lookup; it does not
document the custom signed Khalti webhook accepted by this application. Do not
treat that webhook as a production dependency until Khalti confirms its schema,
signature, retries and dispute events for this merchant account.

## Additional integration matrices

## Fonepay dynamic QR matrix

| Action                    | Local behavior                                                                                                                     | Audit result                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Merchant authentication   | Authenticates server-to-server and refreshes the token from provider expiry                                                        | Implemented and failure-closed                                 |
| QR initiation             | Enforces NPR 1-9,999,999, generates a <=30-character alphanumeric PRN, signs the exact JSON, and validates response status and PRN | Aligned with supplied v1.10 contract                           |
| Payment status            | Polls the provider, validates PRN, merchant code and exact requested amount before completion                                      | Implemented and automated-tested                               |
| Unknown/mismatched result | Rejects completion and retains provider-call evidence                                                                              | Implemented and automated-tested                               |
| WebSocket notification    | Browser listens to the returned `wss:` URL and triggers authoritative backend status lookup; polling/manual check remain available | Aligned; socket data is never trusted as payment evidence      |
| Refunds                   | No automatic provider call; shared dual-control manual workflow records the externally completed refund                            | Intentional product policy, implemented for Khalti and Fonepay |

The adapter was reconciled against the supplied Checkout by Fonepay Intent Flow
v1.10 (May 2026) and Postman collection. The document does not define an HTTP
payment webhook or refund endpoint. Its realtime mechanism is a WebSocket
notification followed by the authoritative status API, which is the implemented
model. Merchant-sandbox E2E remains the provider-certification gate.

## Partner API matrix

The first-party Partner API implements scoped bearer credentials, capabilities,
catalogue and quotes, document upload/confirmation, prepaid and hosted orders,
traveller updates, payment sessions, cancellation, refund requests, eSIM and
usage reads/refresh, order events and notification requests. Administrative
flows cover partner lifecycle, keys, price lists, ledger adjustments, hosted
links, outbound webhook endpoints/deliveries/replay and refund review. Contract,
prepaid, hosted, usage and admin suites exercise ownership, scope, idempotency
and settlement behavior. Consumer certification against the published OpenAPI
and at least one real partner client remains a release gate.

Partner API and partner-hosted checkout support universal cross-channel
top-ups. The MSISDN identifies the beneficiary eSIM and `externalCustomerId`
identifies the partner-side purchaser. The order remains attached to the
established eSIM owner through `customerId` and `targetInventoryId`; `partnerId`
and `partnerCustomerId` separately retain the initiating partner and purchaser.
This is a blind add-value operation, not an ownership transfer. Purchasing a
top-up does not grant access to the beneficiary's identity, activation details,
aggregate usage, documents, other orders or lifecycle controls. Management and
usage access require that the partner supplied the physical eSIM through an
initial-purchase order.

Partner settlement is prepaid-only. A Partner API initial purchase reserves the
retail amount in the same transaction that creates the order, captures that
reservation when the verified order is finalized, and releases it on
cancellation or verification expiry. Partner API top-ups debit immediately.
Customer-funded hosted checkout remains independent of the partner balance and
continues to require an authoritative Khalti or Fonepay payment confirmation.
Spendable balance is `balancePaisa - reservedPaisa`; partner credit limits are
disabled. Ops adjustments cannot reduce cash below the reserved total or reset
financial state, and the reconciliation worker releases any reservation left on
a terminal API order.

## Credential-backed release gates

1. Confirm Transatel OAuth scopes for catalog read, inventory read, product
   write, SIM read and subscriber lifecycle actions.
2. Verify a real test eSIM has a correctly paired ICCID + MSISDN locally.
3. Run initial `preload` -> QR -> ACTIVATED callback.
4. Run `subscribe` top-up -> new subscription ID -> balance visible; verify no
   new QR and no overwrite of the original package ID.
5. Replay/reorder real webhooks, including expiry of an older package after a
   newer top-up.
6. Suspend and terminate only a designated test eSIM and reconcile final state.
   Configure and test the callback datastream in the Transatel Developer
   Console; API-based webhook subscription is no longer supported.
7. Run Khalti Completed, Pending, Expired and User-canceled lookups; verify
   exact paisa, pidx and transaction ID persistence.
8. Exercise manual refunds for one Khalti and one Fonepay payment, including
   rejection, duplicate request/reference, wrong amount and concurrent completion.
9. Confirm batch inventory delivery versus Transatel reserve/release.

Until these checks pass, the system is contract-audited and automated-test
ready, but it must not be described as fully provider-certified.
