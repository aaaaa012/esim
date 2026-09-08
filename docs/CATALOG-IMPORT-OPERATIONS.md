# Catalogue import operations

## Two safe import scopes

- `FULL_CATALOG` is used by the Inventory monthly-package uploader. Every
  existing country/provider-product pair absent from the file is recorded as
  `MISSING`; it is not automatically disabled or deleted.
- `UPDATE_LISTED` is used by the Admin plan workspace for targeted commercial
  corrections. Omitted products are untouched and are never marked missing.

The stable plan identity is `(countryIso2, providerPlanId)`. Repeated monthly
rows update that plan instead of creating duplicates. Historical orders retain
their pricing snapshots.

## Monthly classifications

Every full upload creates a `CatalogImportBatch` with one durable
`CatalogImportRow` per uploaded or missing product:

- `NEW`: a new plan is created. It defaults to `DRAFT`; only an explicit
  `ACTIVE` from a Super Admin activates it immediately.
- `UPDATED`: the existing plan changes immediately without a second approval.
- `UNCHANGED`: no commercial/provider value changed, but presence in this
  batch is still recorded.
- `MISSING`: the plan was absent. Ops may explicitly disable it from Catalogue
  reviews; it remains unchanged until that action.
- `RETURNED`: a previously missing plan reappeared. Its provider-missing marker
  is cleared and its status becomes `DRAFT` for a deliberate re-release.
- `INVALID`: the row is not applied and retains its validation reason.

The batch stores the file name, SHA-256 content fingerprint, uploader, time,
scope, totals, and previous/proposed row values. Ops can filter every batch by
classification and inspect which fields changed.

## Downloads

- **Download latest Transatel catalogue** calls the provider catalogue endpoint
  and returns an import-compatible snapshot without changing the database.
- **Export current Visa Compass catalogue** reads the operating `Plan` and
  `Country` tables only and does not call Transatel.

Provider calls continue through the standard integration client, so request,
response, endpoint, timing, correlation and outcome details use the central
integration logging path.
