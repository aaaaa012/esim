ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CHARGED_BACK';

CREATE TYPE IF NOT EXISTS "PaymentDisputeType" AS ENUM ('CHARGEBACK', 'DISPUTE');
CREATE TYPE IF NOT EXISTS "PaymentDisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'WON', 'LOST', 'RESOLVED');

CREATE TABLE IF NOT EXISTS "PaymentDispute" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "providerCaseId" STRING NOT NULL,
  "openedEventId" STRING NOT NULL,
  "type" "PaymentDisputeType" NOT NULL,
  "status" "PaymentDisputeStatus" NOT NULL DEFAULT 'OPEN',
  "amount" DECIMAL(12,2),
  "currency" STRING NOT NULL DEFAULT 'NPR',
  "reason" STRING,
  "providerEvidence" JSONB,
  "resolutionNote" STRING,
  "openedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "PaymentDispute_pkey" PRIMARY KEY ("id")
);

-- CockroachDB may schema-lock newly created changefeed-watched tables. Unlock
-- only this table while adding its indexes/constraints, then restore the lock.
ALTER TABLE "PaymentDispute" SET (schema_locked = false);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentDispute_provider_providerCaseId_key" ON "PaymentDispute"("provider", "providerCaseId");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentDispute_provider_openedEventId_key" ON "PaymentDispute"("provider", "openedEventId");
CREATE INDEX IF NOT EXISTS "PaymentDispute_status_openedAt_idx" ON "PaymentDispute"("status", "openedAt");
CREATE INDEX IF NOT EXISTS "PaymentDispute_orderId_status_idx" ON "PaymentDispute"("orderId", "status");

ALTER TABLE "PaymentDispute" ADD CONSTRAINT IF NOT EXISTS "PaymentDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute" ADD CONSTRAINT IF NOT EXISTS "PaymentDispute_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentDispute" SET (schema_locked = true);
