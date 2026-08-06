# 18 — Operations Web

Primary source: `apps/ops-web/src/app/**` (Next.js App Router; Clerk +
`authenticated-api-provider.tsx`; sidebar shows the Admin section only when
`effectiveCapabilities` includes `admin:portal` — `ops-sidebar.tsx:42`).

## Conventions

- `NEXT_PUBLIC_API_URL` defaults to `http://localhost:4000/api/v1`
  (`middleware.ts:9`).
- All calls go through `useAuthenticatedFetch()` and are idempotent
  (mutations send `x-idempotency-key: crypto.randomUUID()` where the API
  accepts it — e.g. `review.tsx:68`).

## Sidebar navigation

`ops-sidebar.tsx:18-27`: Dashboard `/`, Work Queue `/work-queue`, Orders
`/orders`, Customers `/customers`, Inventory `/inventory`, Notifications
`/notifications`, Integration Events `/integration-events`, Audit Log `/audit`,
plus Administration `/admin` for `admin:portal` holders.

## Pages → API calls

| Page | API calls |
| --- | --- |
| Dashboard (`dashboard-client.tsx`) | `GET /operations/dashboard` (`:37`) |
| Work Queue (`work-queue/page.tsx`) | `GET /operations/orders` (status-filtered client-side to `REVIEW_PENDING`, `AWAITING_CUSTOMER`, `PROVISIONING_FAILED` — `orders-client.tsx:11`) |
| Orders (`orders-client.tsx`) | `GET /operations/orders` (`:10`) |
| Order review (`review.tsx`) | `GET /operations/orders/{id}` (`:49`); document `POST .../documents/{id}/approve`, `/request-reupload` (`:194,205`); order `POST .../approve`, `/retry` (`:256,270`); refund `/refund`, cancel `/cancel` (`:288,302`); document content `GET .../documents/{id}/content` (`:84`) |
| Customers (`customers-client.tsx`) | `GET /operations/customers` (`:8`) |
| Customer profile (`customer-profile-client.tsx`) | `GET /operations/customers/{ownerId}` (`:51`); `POST /operations/orders/{id}/usage/refresh` (`:68`) |
| Inventory (`inventory-client.tsx`) | `GET /operations/inventory` (`:14`); `POST /operations/inventory/import` (`:16`); `POST /operations/inventory/import-csv` (`:17`) |
| Notifications (`notifications-client.tsx`) | `GET /operations/notifications` (`:9`); `POST /operations/notifications/{id}/retry` (`:14`) |
| Integration Events (`integration-events-client.tsx`) | `GET /operations/integration-events` (`:7`) |
| Audit (`audit-client.tsx`) | `GET /operations/audit` (`:8`) |
| Admin workspace (`admin/workspace.tsx`) | `GET /admin/plans`, `/admin/integrations`, `/admin/users`, `/admin/staff-invitations` (`:113-116`); `PATCH /admin/plans/{id}` (`:131`); `POST /admin/plans/import-csv` (`:164`); `POST /admin/integrations/{id}/test` (`:182`); `PATCH /admin/users/{id}/account-type` (`:228`) |
| Admin → Integrations (`admin/integrations/integrations-client.tsx`) | `GET /admin/integrations`, `/admin/plans`, `/operations/integration-logs` (`:62-64`); `POST /admin/integrations/{id}/test` (`:79`); `POST /admin/integrations/transatel/sync-catalog` and `/ensure-webhook` (`:93`); Transatel eligibility check |
| Staff onboarding (`staff-onboarding/page.tsx`) | invite + accept flows via `/admin/staff-invitations` |
| Security (`security/[[...security]]`) | Clerk security/account pages |

## Notes

- Order review sends `opsHeaders` (accept) and treats response
  `{ data }`/`{ error }` via the shared envelope.
- Document preview is rendered from an authenticated blob URL
  (`URL.createObjectURL`), so it is never cached or publicly linkable
  (`review.tsx:92`).
