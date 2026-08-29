# 17 — Customer Web

Primary source: `apps/customer-web/src/app/**` (Next.js App Router, client-side
Clerk auth, no backend rendering).

## Conventions

- `NEXT_PUBLIC_API_URL` defaults to `http://localhost:4000/api/v1`
  (`middleware.ts:4`, `authenticated-api-provider.tsx:4`).
- `authenticated-api-provider.tsx` wraps `window.fetch` and injects the Clerk
  Bearer token (`:33`); guest checkout swaps `/customer/orders` →
  `/guest/orders` (`checkout-client.tsx:104-110`).
- `apiErrorMessage(value.error?.code, value.error?.message)` is used to render
  shared error codes (`errors.ts`).

## Pages → API calls

| Page                | Route                                                 | API calls                                                                                                                                                        |
| ------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing / catalog   | `/` (`page.tsx`, `catalog-plans.tsx`)                 | `GET /public/plans`, `GET /public/coverage/{country}` (`catalog-plans.tsx:50,73`)                                                                                |
| Compatibility check | `/compatibility`                                      | same coverage endpoints                                                                                                                                          |
| Top-up lookup       | `/topup-lookup.tsx` (guest, no auth)                  | `POST /guest/orders/topup-lookup` (`topup-lookup.tsx:32`)                                                                                                        |
| Checkout            | `/esim/checkout` (`checkout-client.tsx`)              | full guest order lifecycle: create → payment → traveler → documents → confirm; urls derived from `POST /customer/orders` responses, rewritten to `/guest/orders` |
| Sign-in             | `/sign-in/[[...sign-in]]`                             | Clerk redirect flow                                                                                                                                              |
| My eSIMs            | `/account/esims` (`esim-list.tsx`)                    | `GET /customer/orders`                                                                                                                                           |
| eSIM detail         | `/account/esims/[id]` (`esim-details.tsx`)            | `GET /customer/orders/{id}`; document upload `POST /customer/orders/{id}/documents`; confirm `POST .../documents/{documentId}/confirm` (`:59,78,116`)            |
| Notifications       | `/account/notifications` (`notification-history.tsx`) | `GET /customer/notifications`                                                                                                                                    |

## Guest checkout flow (no account)

`checkout-client.tsx` drives the whole flow against `/guest/orders`:

1. `POST /guest/orders` `{ planId, compatibilityAccepted: true }` →
   `{ order }` plus `paymentUrl` / `authorization`.
2. Payment: redirects to the provider URL (simulator redirect in
   `.env.example`), then returns to `/guest/orders/{id}/status`.
3. `POST .../traveler` with `TravelerInput`; 4. `POST .../documents` returns
   signed upload (`upload.mode: 'local-simulator'` → confirm immediately;
   `'s3-presigned'` → direct Amazon S3 upload,
   `checkout-client.tsx:318-346`); 5. `POST .../documents/{id}/confirm`;
4. `POST .../submit`; 7. `GET /customer/orders/{id}` equivalent to view the
   final state.
