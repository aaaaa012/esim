ALTER TYPE "TransatelLifecycleAction" ADD VALUE IF NOT EXISTS 'REACTIVATE';
ALTER TYPE "TransatelLifecycleState" ADD VALUE IF NOT EXISTS 'APPROVAL_REQUIRED';
ALTER TYPE "TransatelLifecycleState" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "TransatelLifecycleState" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE "TransatelLifecycleOperation"
ADD COLUMN "approvedById" UUID,
ADD COLUMN "approvedAt" TIMESTAMP(3);

ALTER TABLE "TransatelLifecycleOperation"
ADD CONSTRAINT "TransatelLifecycleOperation_approvedById_fkey"
FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "TransatelLifecycleOperation_approvedById_idx"
ON "TransatelLifecycleOperation"("approvedById");
