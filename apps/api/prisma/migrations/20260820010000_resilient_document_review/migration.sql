CREATE TYPE "DocumentReviewPolicy" AS ENUM ('AUTO_OCR', 'MANUAL_REVIEW');
CREATE TYPE "DocumentReviewStatus" AS ENUM ('NOT_STARTED', 'OCR_PENDING', 'OCR_BACKGROUND', 'VERIFIED', 'MANUAL_REVIEW', 'REUPLOAD_REQUIRED', 'MANUALLY_APPROVED', 'SKIPPED');

ALTER TABLE "Order"
  ADD COLUMN "documentReviewPolicy" "DocumentReviewPolicy" NOT NULL DEFAULT 'AUTO_OCR',
  ADD COLUMN "documentReviewStatus" "DocumentReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "documentReviewStartedAt" TIMESTAMP(3),
  ADD COLUMN "documentCheckoutReleaseAt" TIMESTAMP(3);

CREATE TABLE "PlatformConfiguration" (
  "id" STRING NOT NULL DEFAULT 'platform',
  "documentReviewPolicy" "DocumentReviewPolicy" NOT NULL DEFAULT 'AUTO_OCR',
  "ocrCheckoutWaitMs" INT4 NOT NULL DEFAULT 8000,
  "updatedById" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformConfiguration_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PlatformConfiguration" ("id", "documentReviewPolicy", "ocrCheckoutWaitMs", "updatedAt")
VALUES ('platform', 'AUTO_OCR', 8000, CURRENT_TIMESTAMP);

ALTER TABLE "PartnerDocumentVerification"
  ADD COLUMN "reviewPolicy" "DocumentReviewPolicy" NOT NULL DEFAULT 'AUTO_OCR',
  ADD COLUMN "checkoutReleaseAt" TIMESTAMP(3);
