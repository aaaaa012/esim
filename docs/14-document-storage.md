# 14 — Private Document Storage

Primary source: `apps/api/src/infrastructure/s3-storage.service.ts`.

## Overview

`S3StorageService` stores private travel documents in Amazon S3. It issues
short-lived presigned upload authorizations, verifies uploaded object metadata
and file signatures, provides five-minute presigned reads, and downloads bytes
for operations and OCR. When AWS storage is absent outside production it uses
the existing `local-simulator` flow.

## Configuration

- `AWS_REGION` — region containing the private bucket.
- `AWS_S3_BUCKET` — private bucket name.
- `AWS_S3_ENDPOINT` and `AWS_S3_FORCE_PATH_STYLE=true` — optional settings for
  a local S3-compatible service; do not use them for production AWS S3.
- Credentials come from the AWS SDK default credential chain. In production,
  attach an IAM role to the workload instead of exporting long-lived access
  keys.

The workload role needs only `s3:PutObject`, `s3:GetObject`, and
`s3:DeleteObject` for `arn:aws:s3:::<bucket>/visa-compass/private/*`.

## Presigned upload authorization

`createDocumentUpload(orderId, type, contentType)` and
`createPartnerDocumentUpload(uploadId, type, contentType)` create a random key
under one of these prefixes:

- `visa-compass/private/orders/{orderId}/`
- `visa-compass/private/partner-uploads/{uploadId}/`

When configured, the response is:

```json
{
  "assetId": "visa-compass/private/orders/.../passport-doc_<uuid>",
  "upload": {
    "mode": "s3-presigned",
    "endpoint": "https://<bucket>.s3.<region>.amazonaws.com/...?X-Amz-...",
    "method": "PUT",
    "headers": { "content-type": "application/pdf" },
    "expiresInSeconds": 600
  }
}
```

The browser sends the file bytes directly to `endpoint` using `PUT` and the
returned headers. The signed `content-type` must match exactly. Partner
pre-verification upload URLs last 900 seconds; customer/order URLs last 600.

The bucket CORS policy must allow the customer and partner portal origins to
send `PUT` and the `Content-Type` header. The bucket and objects remain private;
no public-read ACL is used.

## Verification

`verifyDocument(assetId)`:

- Uses `HeadObject` to require a non-empty object no larger than 10 MB.
- Reads only the first 16 bytes and detects PDF, JPEG, or PNG by magic bytes.
- Requires the detected format to match S3 `Content-Type`.
- Rejects missing, oversized, spoofed, or unsupported objects with a sanitized
  `BadRequestException`.

## Reading and OCR

- `signedReadUrl` creates a private `GetObject` URL valid for 300 seconds.
- `downloadDocument` streams the object through the AWS SDK and enforces the
  10 MB limit.
- `downloadDocumentImage` returns JPEG/PNG bytes directly. For PDF passports,
  it writes the bytes to a mode-0600 temporary directory and uses `pdftoppm` to
  rasterize only page one as a grayscale JPEG capped at 2000 px. The temporary
  directory is always removed. The production Docker image installs
  `poppler-utils` for this path.

## Local simulator

Outside production, missing `AWS_REGION` or `AWS_S3_BUCKET` returns
`upload.mode = 'local-simulator'`. The client skips the byte upload and calls
the confirm endpoint, where verification returns a simulated result. Production
fails closed when storage is absent.

## Security and bucket lifecycle

- Enable S3 Block Public Access and bucket-owner-enforced object ownership.
- Keep default S3 server-side encryption enabled; use a customer-managed KMS
  key if policy requires it.
- Restrict the workload role to the private prefix above.
- Configure a lifecycle rule appropriate to the legal retention period.
- Log S3 data events for the private prefix when audit requirements call for
  object-level access records.
