CREATE TYPE "PaymentInitiationStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "PaymentInitiation" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "amountNpr" INTEGER NOT NULL,
    "status" "PaymentInitiationStatus" NOT NULL DEFAULT 'PROCESSING',
    "claimToken" UUID NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentInitiation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentInitiation_orderId_key" ON "PaymentInitiation"("orderId");
CREATE INDEX "PaymentInitiation_status_leaseExpiresAt_idx" ON "PaymentInitiation"("status", "leaseExpiresAt");
ALTER TABLE "PaymentInitiation" ADD CONSTRAINT "PaymentInitiation_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
