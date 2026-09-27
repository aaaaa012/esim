# 09 — Connectivity (Transatel)

Primary sources: `apps/api/src/modules/integration/connectivity-provider.ts`
(contract), `apps/api/src/modules/integration/transatel.provider.ts`
(implementation), `apps/api/src/modules/integration/connectivity.service.ts`
(thin facade). Design intent: `docs/ADR-002-provider-adapters.md`.

## Provider contract

`connectivity-provider.ts`:

```ts
interface ConnectivityProvider {
  readonly name: string;
  health(): Promise<{ ok: boolean }>;
  capabilities(): ConnectivityCapabilities; // catalogSync, provisioning, usage, esimDetails, topUp, callbacks
  provision(request: ProvisionRequest): Promise<ProvisionResult>;
  getUsage(subscriptionId: string): Promise<{ usedMb; totalMb }>;
  getEsimDetails(subscriptionId: string): Promise<EsimDetailsResult>;
  syncCatalog?(): Promise<CatalogSyncResult>;
  checkEligibility?(planId, msisdn): Promise<EligibilityResult>;
  handleWebhook?(payload): Promise<ProviderWebhookResult>;
}
```

`ProvisionRequest = { orderId, planId, eid, traveler: { firstName, surname,
email, mobile, city, countryOfResidence } }`.
`ProvisionResult = { providerSubscriptionId, status: 'COMPLETED'|'DELAYED',
qrPayload?, smDpAddress? }`.

## `TransatelProvider`

`transatel.provider.ts`. The only implementation. `name = 'TRANSATEL'`
(`transatel.provider.ts:120`).

### Auth / token

- Client-credentials OAuth: `POST {base}/authentication/api/token` with Basic
  auth (client id:secret) and `grant_type=client_credentials`
  (`transatel.provider.ts:156-190`).
- Token cached with a 30 s safety window (`transatel.provider.ts:161`).
- On 401 the cached token is invalidated and retried once
  (`authorizedFetch`, `transatel.provider.ts:192-220`).
- Timeout via `TRANSATEL_REQUEST_TIMEOUT_MS` (default 15 s)
  (`transatel.provider.ts:151-154`).

### Domain base URLs

`baseUrl(domain)` appends the domain to `TRANSATEL_BASE_URL`
(`transatel.provider.ts:145-149`): `authentication`, `ocs/subscriptions`,
`ocs/inventory`, `ocs/catalog`, `sim-management/sims`, `webhooks`.

### Provisioning (`provision`, `transatel.provider.ts:287-329`)

1. Requires `TRANSATEL_MVNO_REF` and a plan with a `providerPlanId`.
2. Finds an allocated eSIM profile by orderId or eid.
3. OCS calls always use the subscriber MSISDN. ICCID is used only for SIM-management `sim-serial` calls.
4. `POST {base}/ocs/subscriptions/api/orders/products` with payload:
   `{ bind: { msisdn }, source: 'api', orderType: 'preload' | 'subscribe',
mvnoRef, product: { productId: plan.providerPlanId },
payment?, transactionReference: orderId }`. Initial purchases use `preload`;
top-ups use `subscribe`.
5. After an initial preload, fetches eSIM details; if a QR is available returns
   `status: 'COMPLETED'` with qrPayload/smDpAddress; otherwise returns
   `status: 'DELAYED'`. A successful top-up subscribe is complete immediately
   and deliberately does not fetch or deliver another QR.

### Usage (`getUsage`, `transatel.provider.ts:331-358`)

- Resolves subscriber identifier from a reference (ICCID, order UUID, or
  subscription id) via `resolveSubscriber`
  (`transatel.provider.ts:258-285`).
- `GET {base}/ocs/inventory/api/subscriptions/products?msisdn=..&withBalances=true`.
- Filters out `terminated` subscriptions; computes used/total MB from SCP
  balance entries where `resourceUnit === 'KB'`; handles unlimited
  (`resourceValue === -1`); sums across subscriptions
  (`transatel.provider.ts:340-358`).

### eSIM details (`getEsimDetails`, `transatel.provider.ts:360-375`)

- `GET {base}/sim-management/sims/api/esims/sim-serial/{iccid}`.
- Maps status + optional `smDpAddress` and `qrPayload` (from `qrCode.value`
  or `activationCode`).

### Catalog sync (`syncCatalog`, `transatel.provider.ts:377-456`)

- Requires Prisma (persistence).
- `GET {base}/ocs/catalog/api/cos/{COS}/products?availabilityStatus=AVAILABLE&categories=One-off`.
- For each product: converts ISO3 country list to ISO2, computes validity
  days (months ×30), allowance MB (GB×1024, KB/1024), and NPR price via
  `TRANSATEL_FX_TO_NPR` with cent handling
  (`transatel.provider.ts:594-635`).
- Upserts `Country` and `Plan` rows keyed on `countryId_providerPlanId`;
  sets cost=selling=converted price, status ACTIVE.
- Returns `{ synced, skipped }`.

### Eligibility (`checkEligibility`, `transatel.provider.ts:458-475`)

- `GET {base}/ocs/catalog/api/cos/{COS}/products/{providerPlanId}?msisdn=..`.
- 403/404 → `{ allowed: false, errorKey: 'ELIGIBILITY_REJECTED', ... }`.
- Otherwise returns `allowed` from `canSubscribe.allowed` plus errorKey/message.

### Webhook datastream configuration

- API-based webhook subscription was removed by Transatel in February 2026.
- Configure the callback URL, shared secret and required lifecycle events as a
  datastream in the Transatel Developer Console, then send a Console test event.

### Inbound webhook handling (`handleWebhook`, `transatel.provider.ts:508-582`)

- Normalizes envelope from `header`/`body` or a flat object
  (`normalizeEnvelope`, `transatel.provider.ts:549-582`).
- Extracts eventType, ICCID (from multiple candidate fields), subscriptionId,
  activatedAt, expiresAt.
- Resolves the ICCID to an order via `EsimInventory.assignedOrderId`.
- Maps event type → status (`mapEventType`): `*ACTIVATED`, `*PRELOADED`,
  `*EXPIRED`, `*TERMINATED`, `*CANCELED/CANCELLED`, else `OTHER`
  (`transatel.provider.ts:584-592`).
- For ACTIVATED on a non-completed order, tries to enrich the QR payload by
  fetching eSIM details (`transatel.provider.ts:534-544`).
- Returns `ProviderWebhookResult` with the mapped `ProviderWebhookEvent`.

### Observability

Every outbound call is recorded into `IntegrationLog` (operation, method,
endpoint, status, duration, errorCode/errorMessage) when Prisma is enabled
(`transatel.provider.ts:222-239`).

## `ConnectivityService`

`connectivity.service.ts` — a thin wrapper delegating every method to
`TransatelProvider` (`connectivity.service.ts:35-43`), plus startup hooks:

- It never attempts obsolete API-based webhook registration on startup.
- If `TRANSATEL_CATALOG_SYNC_ON_STARTUP === 'true'`, syncs the catalog
  (`connectivity.service.ts:23-32`).

`descriptor()` exposes `{ provider: 'TRANSATEL', capabilities }`
(`connectivity.service.ts:35`).

## Error codes

Connectivity errors use `ApiException` with stable codes from
`packages/shared/src/errors.ts`: `CONNECTIVITY_CONFIGURATION`,
`CONNECTIVITY_UNAVAILABLE`, `PLAN_NOT_AVAILABLE`, `PROVISIONING_FAILED`,
`INVENTORY_UNAVAILABLE`, `USAGE_UNAVAILABLE`, `ELIGIBILITY_REJECTED`.

Messages are customer-safe; provider details go in `details` (logged, never
serialized) (`transatel.provider.ts:141-147`).
