ALTER TABLE "PassportExtraction"
ADD COLUMN "lastMismatchFingerprint" TEXT,
ADD COLUMN "lastMismatchFields" JSONB,
ADD COLUMN "confirmedMismatchFingerprint" TEXT;
