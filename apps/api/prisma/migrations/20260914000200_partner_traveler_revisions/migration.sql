CREATE TABLE "PartnerTravelerRevision" (
    "id" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "idempotencyKeyHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "travelerSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartnerTravelerRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PartnerTravelerRevision_verificationId_version_key" ON "PartnerTravelerRevision"("verificationId", "version");
CREATE UNIQUE INDEX "PartnerTravelerRevision_verificationId_idempotencyKeyHash_key" ON "PartnerTravelerRevision"("verificationId", "idempotencyKeyHash");
CREATE INDEX "PartnerTravelerRevision_verificationId_createdAt_idx" ON "PartnerTravelerRevision"("verificationId", "createdAt");

ALTER TABLE "PartnerTravelerRevision" ADD CONSTRAINT "PartnerTravelerRevision_verificationId_fkey"
FOREIGN KEY ("verificationId") REFERENCES "PartnerDocumentVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
