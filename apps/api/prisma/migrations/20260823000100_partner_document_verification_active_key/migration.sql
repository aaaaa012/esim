-- One partner may have only one resumable document-verification workflow for
-- a given external order. Historical, consumed, invalid, and expired attempts
-- leave this nullable key empty and remain available for audit.
ALTER TABLE "PartnerDocumentVerification"
ADD COLUMN "activeExternalOrderKey" TEXT;

WITH ranked AS (
  SELECT
    "id",
    "partnerId",
    "externalOrderId",
    ROW_NUMBER() OVER (
      PARTITION BY "partnerId", "externalOrderId"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS row_number
  FROM "PartnerDocumentVerification"
  WHERE "consumedAt" IS NULL
    AND "expiresAt" > CURRENT_TIMESTAMP
    AND "status" NOT IN ('EXPIRED', 'INVALID', 'CONSUMED')
)
UPDATE "PartnerDocumentVerification" AS verification
SET "activeExternalOrderKey" = ranked."partnerId"::text || ':' || ranked."externalOrderId"
FROM ranked
WHERE verification."id" = ranked."id"
  AND ranked.row_number = 1;

CREATE UNIQUE INDEX "PartnerDocumentVerification_activeExternalOrderKey_key"
ON "PartnerDocumentVerification"("activeExternalOrderKey");
