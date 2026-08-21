CREATE TYPE "AssignmentVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'MISMATCH');
ALTER TABLE "Subscription"
  ADD COLUMN "assignmentVerificationStatus" "AssignmentVerificationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "assignmentVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "providerLastSeenAt" TIMESTAMP(3);
