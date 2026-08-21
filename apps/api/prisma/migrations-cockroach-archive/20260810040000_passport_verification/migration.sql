-- Server-side passport verification (Tesseract OCR vs traveller form), stored
-- on the passport document so it survives restarts and is visible to ops.
ALTER TABLE "TravelerDocument"
  ADD COLUMN "passportVerificationStatus" STRING,
  ADD COLUMN "passportVerificationMethod" STRING,
  ADD COLUMN "passportMatchedFields" JSONB,
  ADD COLUMN "passportConfidence" FLOAT8,
  ADD COLUMN "passportVerifiedAt" TIMESTAMP(3);