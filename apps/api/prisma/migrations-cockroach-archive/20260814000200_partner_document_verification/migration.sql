CREATE TABLE IF NOT EXISTS "PartnerDocumentVerification" (
  "id" UUID NOT NULL,
  "partnerId" UUID NOT NULL,
  "externalOrderId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AWAITING_UPLOAD',
  "travelerSnapshot" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedOrderId" UUID,
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerDocumentVerification_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "PartnerDocumentVerification" SET (schema_locked = false);
ALTER TABLE "PartnerDocumentUploadIntent" ADD COLUMN IF NOT EXISTS "verificationId" UUID;
ALTER TABLE "PartnerDocumentUploadIntent" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT NOT NULL DEFAULT 'AWAITING_UPLOAD';
ALTER TABLE "PartnerDocumentUploadIntent" ADD COLUMN IF NOT EXISTS "verificationCode" TEXT;
ALTER TABLE "PartnerDocumentUploadIntent" ADD COLUMN IF NOT EXISTS "verificationResult" JSONB;
ALTER TABLE "PartnerDocumentUploadIntent" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerDocumentVerification_consumedOrderId_key" ON "PartnerDocumentVerification"("consumedOrderId");
CREATE INDEX IF NOT EXISTS "PartnerDocumentVerification_partnerId_externalOrderId_idx" ON "PartnerDocumentVerification"("partnerId", "externalOrderId");
CREATE INDEX IF NOT EXISTS "PartnerDocumentVerification_status_expiresAt_idx" ON "PartnerDocumentVerification"("status", "expiresAt");
ALTER TABLE "PartnerDocumentVerification" ADD CONSTRAINT IF NOT EXISTS "PartnerDocumentVerification_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerDocumentUploadIntent" ADD CONSTRAINT IF NOT EXISTS "PartnerDocumentUploadIntent_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "PartnerDocumentVerification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PartnerDocumentVerification" SET (schema_locked = true);
