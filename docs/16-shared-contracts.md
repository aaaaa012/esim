# 16 — Shared Contracts

Primary source: `packages/shared/src/{index,contracts,schemas,errors}.ts`.

`@visa-compass/shared` is the internal package shared by the API and both
portals. It is re-exported through `index.ts`.

## Enums (`contracts.ts`)

- `UserRole` — `CUSTOMER | OPERATIONS | SUPER_ADMIN` (`contracts.ts:1-5`).
- `OrderStatus` — the 13 statuses matching the state machine
  (`contracts.ts:7-21`, see `docs/06-domain-model-orders.md`).
- `PaymentProvider` — `KHALTI` (`contracts.ts:23`).
- `PaymentStatus` — `INITIATED | PENDING | COMPLETED | FAILED | CANCELLED |
  REFUNDED` (`contracts.ts:24`).
- `DocumentType` — `PASSPORT | TICKET | VISA` (`contracts.ts:25`).
- `DocumentStatus` — `PENDING | APPROVED | REJECTED | REUPLOAD_REQUIRED`
  (`contracts.ts:26`).
- `InventoryStatus` — `IMPORTED | AVAILABLE | RESERVED | ASSIGNED | ACTIVATED |
  EXPIRED | TERMINATED` (`contracts.ts:27`).
- `ProvisioningStatus` — `QUEUED | RUNNING | DELAYED | SUCCEEDED | RETRYING |
  FAILED` (`contracts.ts:28`).

## Envelope types (`contracts.ts:30-32`)

```ts
type ApiMeta = { correlationId: string; timestamp: string };
type ApiSuccess<T> = { data: T; meta: ApiMeta };
type ApiFailure = { data: null; meta: ApiMeta; error: { code; message; details? } };
```

These are implemented by `CorrelationInterceptor` and `ApiExceptionFilter`
(see `docs/19-observability-hardening.md`).

## Summary types (`contracts.ts:34-52`)

- `PlanSummary` — `{ id, countryCode, name, dataAllowance, validityDays,
  sellingPriceNpr, coverage, popular }`.
- `OrderSummary` — `{ id, orderNumber, status, plan, totalAmountNpr, createdAt }`.

## Zod schemas (`schemas.ts`)

- `createOrderSchema` — `{ planId: uuid, compatibilityAccepted: literal(true) }`
  (`schemas.ts:4`).
- `travelerSchema` (`schemas.ts:5-20`):
  - title `MR | MS | MRS`
  - firstName ≤80, middleName optional ≤80, surname ≤80
  - dateOfBirth ISO date, nationality 2 letters
  - city ≤100, countryOfResidence 2 letters
  - employerOrBusinessName optional ≤160
  - email valid, mobile 7–20 chars
  - passportNumber 5–30, passportExpiryDate ISO date
  - pointOfSaleCode optional ≤40
- `initiatePaymentSchema` — `{ provider: enum(PaymentProvider) }`
  (`schemas.ts:21`).
- `documentRequestSchema` — `{ type: enum(DocumentType), fileName ≤180,
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png' }`
  (`schemas.ts:22`).

Inferred types: `CreateOrderInput`, `TravelerInput`, `InitiatePaymentInput`
(`schemas.ts:24-26`).

## Error taxonomy (`errors.ts`)

`ApiErrorCode` (`errors.ts:9-56`) groups:

- Transport: `UNEXPECTED`, `RATE_LIMITED`, `NOT_FOUND`, `CONFLICT`
- Validation: `VALIDATION_ERROR`
- Auth: `AUTHENTICATION_REQUIRED`, `ACCOUNT_SYNCHRONIZATION_FAILED`,
  `ACCOUNT_DISABLED`, `ACCOUNT_TYPE_FORBIDDEN`, `MFA_REQUIRED`
- Catalog: `PLAN_NOT_AVAILABLE`, `COVERAGE_UNAVAILABLE`
- Orders: `ORDER_INVALID_STATE`, `ORDER_NOT_FOUND`, `ORDER_IMMUTABLE`,
  `COMPATIBILITY_REQUIRED`, `TRAVELER_REQUIRED`, `DOCUMENTS_REQUIRED`,
  `DOCUMENT_NOT_FOUND`, `DOCUMENT_STORAGE_UNAVAILABLE`
- Payments: `PAYMENT_PROVIDER_ERROR`, `PAYMENT_NOT_CONFIRMED`,
  `PAYMENT_REFERENCE_MISMATCH`, `PAYMENT_EXPIRED`
- Connectivity: `CONNECTIVITY_CONFIGURATION`, `CONNECTIVITY_UNAVAILABLE`,
  `ELIGIBILITY_REJECTED`, `PRODUCT_UNAVAILABLE`, `PROVISIONING_FAILED`,
  `PROVISIONING_DELAYED`, `INVENTORY_UNAVAILABLE`, `INVENTORY_IMPORT_INVALID`,
  `USAGE_UNAVAILABLE`

`apiErrorMessage(code, fallback?)` (`errors.ts:61-115`) maps each code to a
customer-safe message. Default fallback: "Something went wrong. Please try
again."

## Notes

- Only a subset of codes is emitted by the current code (many are reserved).
  The filter treats unknown `HttpException` bodies without a `code` as
  `HTTP_{status}` (`api-exception.filter.ts:67-70`).
- `packages/shared/src/contracts.test.ts` validates an email schema (1 test
  file, 1 test).
