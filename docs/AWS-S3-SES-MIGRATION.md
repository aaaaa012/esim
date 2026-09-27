# AWS S3 and SES Cutover

The application now uses Amazon S3 for private travel documents and Amazon SES
v2 for email. Complete these infrastructure steps before setting
`NODE_ENV=production`.

## 1. Create and secure the S3 bucket

- Place the bucket in `AWS_REGION` and enable Block Public Access.
- Use bucket-owner-enforced object ownership and keep default server-side
  encryption enabled.
- Configure a retention/lifecycle policy appropriate for travel documents.
- Attach this least-privilege shape to the API/workflow/OCR workload role,
  replacing the account, region, and bucket values:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/visa-compass/private/*"
    }
  ]
}
```

Allow direct browser uploads from the real portal origins:

```json
[
  {
    "AllowedOrigins": [
      "https://YOUR_CUSTOMER_DOMAIN",
      "https://YOUR_PARTNER_DOMAIN"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "x-amz-server-side-encryption"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 300
  }
]
```

Set `AWS_REGION` and `AWS_S3_BUCKET`. Let the AWS SDK obtain credentials from
the workload role; do not commit access keys.

## 2. Move existing objects before code cutover

Existing database rows store provider-neutral object keys in
`privateAssetId`, but any bytes already uploaded to Cloudinary remain there.
Before deploying the S3-only release, copy each existing private asset into the
new bucket using the exact same `privateAssetId` as its S3 key. Verify object
counts, byte sizes, content types, and a sample of PDF/JPEG/PNG magic bytes.

Do not disable or delete the old Cloudinary account until every retained object
has been copied, verified, backed up according to policy, and exercised through
the operations preview and OCR flows.

## 3. Configure SES

- Verify `EMAIL_FROM_ADDRESS` or its domain in the chosen SES region.
- Configure DKIM and the custom MAIL FROM domain if required.
- Request production access so recipient addresses do not need verification.
- Grant the workload role `ses:SendEmail` for the verified identity.
- Optionally create an SES configuration set and publish delivery, bounce, and
  complaint events to the monitoring destination.

Set:

```dotenv
NOTIFICATION_MODE=live
EMAIL_PROVIDER=ses
AWS_SES_REGION=ap-south-1
AWS_SES_CONFIGURATION_SET=
EMAIL_FROM_ADDRESS=notifications@example.com
EMAIL_FROM_NAME=Visa Compass
EMAIL_REPLY_TO=support@example.com
```

## 4. Smoke and rollback gates

1. Upload one PDF and one JPEG through each customer and partner flow.
2. Confirm the API rejects a spoofed content type and an object over 10 MB.
3. Preview/download a document through operations.
4. Run passport OCR for an image and a PDF.
5. Send the SES test notification and a real QR attachment.
6. Confirm SES delivery, bounce, and complaint telemetry.
7. Keep the old providers read-only until the observation window closes.

Rollback requires restoring the prior application build and legacy provider
credentials. New objects written after cutover must be copied back before a
rollback that expects Cloudinary reads.

## 5. Configure Textract OCR overflow

The OCR worker can keep Tesseract as its normal path and route bursts to the
asynchronous Textract text-detection API. The cloud path calls
`StartDocumentTextDetection` with the finalized private S3 object key, then
retrieves every result page with `GetDocumentTextDetection` and `NextToken`.
The stable asset-key hash is used as `ClientRequestToken`, making repeated start
requests idempotent for the seven-day Textract token window.

Grant the workload role only the Textract operations used by this flow; its
existing private-document `s3:GetObject` permission lets Textract read the
specified object:

```json
{
  "Effect": "Allow",
  "Action": [
    "textract:StartDocumentTextDetection",
    "textract:GetDocumentTextDetection"
  ],
  "Resource": "*"
}
```

Deploy initially with `PASSPORT_OCR_MODE=local`. After the IAM and non-sensitive
fixture smoke tests pass, set `PASSPORT_OCR_MODE=hybrid`. New jobs overflow when
the local queue has two waiting jobs, the oldest wait reaches 20 seconds, or the
OCR heartbeat is stale. To roll back without redeploying, restore
`PASSPORT_OCR_MODE=local`, allow the `documents-textract` queue to drain, and
then remove the Textract permission.
