CREATE TABLE "PassportExtraction" (
    "id" UUID NOT NULL,
    "orderId" UUID,
    "partnerVerificationId" UUID,
    "passportAssetId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payloadEncrypted" TEXT,
    "fieldsRequiringInput" JSONB,
    "confidence" DOUBLE PRECISION,
    "method" TEXT,
    "failureCode" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PassportExtraction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PassportExtraction_exactly_one_owner" CHECK (
      (("orderId" IS NOT NULL)::int + ("partnerVerificationId" IS NOT NULL)::int) = 1
    ),
    CONSTRAINT "PassportExtraction_status_check" CHECK (
      "status" IN ('READY', 'PARTIAL', 'MANUAL_ENTRY_REQUIRED', 'SKIPPED')
    )
);

ALTER TABLE "PartnerDocumentVerification"
ALTER COLUMN "travelerSnapshot" DROP NOT NULL,
ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'TRAVELER_FIRST';

ALTER TABLE "PartnerDocumentVerification"
ADD CONSTRAINT "PartnerDocumentVerification_mode_check"
CHECK ("mode" IN ('EXTRACT_FIRST', 'TRAVELER_FIRST'));

CREATE UNIQUE INDEX "PassportExtraction_orderId_key" ON "PassportExtraction"("orderId");
CREATE UNIQUE INDEX "PassportExtraction_partnerVerificationId_key" ON "PassportExtraction"("partnerVerificationId");
CREATE INDEX "PassportExtraction_status_updatedAt_idx" ON "PassportExtraction"("status", "updatedAt");

ALTER TABLE "PassportExtraction"
ADD CONSTRAINT "PassportExtraction_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PassportExtraction"
ADD CONSTRAINT "PassportExtraction_partnerVerificationId_fkey"
FOREIGN KEY ("partnerVerificationId") REFERENCES "PartnerDocumentVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
