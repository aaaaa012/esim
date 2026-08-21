CREATE TYPE "ManualRefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED');
CREATE TYPE "ManualRefundReason" AS ENUM ('PROVISIONING_FAILURE', 'INCORRECT_FULFILLMENT', 'DUPLICATE_CHARGE', 'PROVIDER_SERVICE_FAILURE', 'INTERNAL_OPERATIONAL_ERROR');

CREATE TABLE "ManualRefund" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "status" "ManualRefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "activeKey" STRING,
  "reason" "ManualRefundReason" NOT NULL,
  "explanation" STRING NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "requestedById" UUID NOT NULL,
  "reviewedById" UUID,
  "reviewNote" STRING,
  "providerReference" STRING,
  "completionNote" STRING,
  "completedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManualRefund_pkey" PRIMARY KEY ("id")
);

-- CockroachDB installations with rangefeed/changefeed schema locking can
-- automatically lock a newly created table before the remaining migration
-- statements run. Unlock only for this schema change and restore the lock at
-- the end so fresh deployments remain compatible with that policy.
ALTER TABLE "ManualRefund" SET (schema_locked = false);

CREATE INDEX "ManualRefund_status_createdAt_idx" ON "ManualRefund"("status", "createdAt");
CREATE INDEX "ManualRefund_orderId_createdAt_idx" ON "ManualRefund"("orderId", "createdAt");
CREATE UNIQUE INDEX "ManualRefund_activeKey_key" ON "ManualRefund"("activeKey");
CREATE UNIQUE INDEX "ManualRefund_providerReference_key" ON "ManualRefund"("providerReference");
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ManualRefund" ADD CONSTRAINT "ManualRefund_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ManualRefund" SET (schema_locked = true);
