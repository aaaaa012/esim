# 14 — Private Document Storage

Primary source: `apps/api/src/infrastructure/cloudinary-storage.service.ts`.

## Overview

`CloudinaryStorageService` manages travel-document uploads. It issues short-lived
signed upload authorizations, verifies uploaded documents, and provides signed
read URLs and downloads. When Cloudinary credentials are absent it operates in
a `local-simulator` mode so the whole flow still works offline.

## Signed upload authorization

`createDocumentUpload(orderId, type)` (`cloudinary-storage.service.ts:13-28`):

- `assetId = doc_{uuid}`.
- Folder: `visa-compass/private/orders/{orderId}`.
- If any of `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` /
  `CLOUDINARY_API_SECRET` is missing:
  - Returns `{ assetId, upload: { mode: 'local-simulator', timestamp,
    signature: sha256(`${assetId}:${timestamp}`), folder,
    expiresInSeconds: 600 } }`.
- Otherwise (Cloudinary configured):
  - `publicId = {type.toLowerCase()}-{assetId}`.
  - `signature = cloudinary.utils.api_sign_request({ timestamp, folder,
    public_id: publicId, type: 'authenticated' }, apiSecret)`.
  - Returns `{ assetId: '{folder}/{publicId}', upload: { mode:
    'cloudinary-signed', endpoint: https://api.cloudinary.com/v1_1/{cloudName}/auto/upload,
    cloudName, apiKey, publicId, deliveryType: 'authenticated', timestamp,
    signature, folder, expiresInSeconds: 600 } }`.

The client uploads directly to the Cloudinary endpoint with the signature
(`checkout-client.tsx:325-346`).

## Verification

`verifyDocument(assetId)` (`cloudinary-storage.service.ts:30-44`):

- Simulator mode: returns `{ bytes: 0, format: 'pdf', simulated: true }`.
- Cloudinary mode: loads the resource (`type: 'authenticated'`,
  `resource_type: 'image'`) and enforces:
  - Format must be `pdf`, `jpg`, `jpeg`, or `png`.
  - Size must be ≤ 10 MB.
  - Otherwise `BadRequestException` "Document must be a PDF, JPG or PNG up to
    10 MB"; any other failure → "Document upload could not be verified".

## Reading documents

- `signedReadUrl(assetId)` (`cloudinary-storage.service.ts:46-50`): throws
  `ServiceUnavailableException` when unconfigured; otherwise returns a
  Cloudinary signed URL valid for 300 seconds (`type: 'authenticated'`,
  `resource_type: 'image'`, `sign_url: true`).
- `downloadDocument(assetId)` (`cloudinary-storage.service.ts:52-57`): fetches
  the signed URL and returns `{ bytes, contentType }`.

## Ops document endpoints

`orders.controller.ts:38` (`GET /operations/orders/:id/documents/:documentId/content`):

- Sets `content-type`, `content-disposition: inline; filename=...` (filename
  sanitized of quotes/newlines), `cache-control: no-store, private`, then
  sends the bytes.

`orders.controller.ts:37` (`.../preview`): returns
`{ url, fileName, contentType, expiresInSeconds: 300 }` from
`documentPreview` (`orders.service.ts:107`).

## Local simulator end-to-end

With default `.env.example` (no Cloudinary), the checkout flow works as:

1. `POST /customer/orders/:id/documents` returns
   `upload.mode = 'local-simulator'`.
2. The client sees `local-simulator` and immediately calls
   `POST .../documents/:documentId/confirm` without uploading anywhere
   (`checkout-client.tsx:318-324`).
3. `confirmDocument` → `storage.verifyDocument` returns the simulated result
   and marks `uploadVerified = true` (`orders.service.ts:106`).

## Security properties

- Uploads are `authenticated` delivery type — not public.
- Signed read URLs expire in 300 s.
- The QR payload in notifications is protected by a PDF password
  (`qr-pdf.service.ts:10-24`, see `docs/11-notifications.md`).
