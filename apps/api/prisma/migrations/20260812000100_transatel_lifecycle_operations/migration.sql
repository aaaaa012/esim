CREATE TYPE "TransatelLifecycleAction" AS ENUM ('SUSPEND', 'TERMINATE');
CREATE TYPE "TransatelLifecycleState" AS ENUM ('CREATED', 'SUBMITTING', 'ACCEPTED', 'CONFIRMED', 'RECONCILE_REQUIRED', 'FAILED');

CREATE TABLE "TransatelLifecycleOperation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "action" "TransatelLifecycleAction" NOT NULL,
  "state" "TransatelLifecycleState" NOT NULL DEFAULT 'CREATED',
  "idempotencyKey" STRING NOT NULL,
  "reason" STRING NOT NULL,
  "performedById" UUID NOT NULL,
  "providerTransactionId" STRING,
  "requestSnapshot" JSONB NOT NULL,
  "responseSnapshot" JSONB,
  "errorMessage" STRING,
  "submittedAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TransatelLifecycleOperation_pkey" PRIMARY KEY ("id")
);

-- CockroachDB installations with schema-locked changefeed tables can inherit the
-- lock before Prisma creates the secondary indexes and foreign keys below.
ALTER TABLE "TransatelLifecycleOperation" SET (schema_locked = false);

CREATE UNIQUE INDEX "TransatelLifecycleOperation_idempotencyKey_key" ON "TransatelLifecycleOperation"("idempotencyKey");
CREATE INDEX "TransatelLifecycleOperation_orderId_createdAt_idx" ON "TransatelLifecycleOperation"("orderId", "createdAt");
CREATE INDEX "TransatelLifecycleOperation_state_createdAt_idx" ON "TransatelLifecycleOperation"("state", "createdAt");
ALTER TABLE "TransatelLifecycleOperation" ADD CONSTRAINT "TransatelLifecycleOperation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransatelLifecycleOperation" ADD CONSTRAINT "TransatelLifecycleOperation_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TransatelLifecycleOperation" SET (schema_locked = true);
