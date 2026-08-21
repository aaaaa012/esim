CREATE TYPE "ProvisioningOperationState" AS ENUM ('CREATED', 'SUBMITTING', 'ACCEPTED', 'WAITING_FOR_QR', 'QR_READY', 'ACTIVATED', 'RECONCILE_REQUIRED', 'REJECTED', 'MANUAL_REVIEW', 'CANCELLED');

CREATE TABLE "ProvisioningOperation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orderId" UUID NOT NULL,
  "provider" STRING NOT NULL DEFAULT 'TRANSATEL',
  "state" "ProvisioningOperationState" NOT NULL DEFAULT 'CREATED',
  "idempotencyKey" STRING NOT NULL,
  "iccid" STRING NOT NULL,
  "providerProductId" STRING NOT NULL,
  "providerOrderId" STRING,
  "providerSubscriptionId" STRING,
  "requestSnapshot" JSONB NOT NULL,
  "responseSnapshot" JSONB,
  "attemptCount" INT4 NOT NULL DEFAULT 0,
  "lastErrorCategory" STRING,
  "lastErrorMessage" STRING,
  "submittedAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "nextReconcileAt" TIMESTAMP(3),
  "reconcileDeadlineAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INT4 NOT NULL DEFAULT 0,
  CONSTRAINT "ProvisioningOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProvisioningOperation_orderId_key" ON "ProvisioningOperation"("orderId");
CREATE UNIQUE INDEX "ProvisioningOperation_idempotencyKey_key" ON "ProvisioningOperation"("idempotencyKey");
CREATE INDEX "ProvisioningOperation_state_nextReconcileAt_idx" ON "ProvisioningOperation"("state", "nextReconcileAt");
CREATE INDEX "ProvisioningOperation_providerSubscriptionId_idx" ON "ProvisioningOperation"("providerSubscriptionId");
ALTER TABLE "ProvisioningOperation" ADD CONSTRAINT "ProvisioningOperation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WebhookEvent" ADD COLUMN "processingStartedAt" TIMESTAMP(3);
ALTER TABLE "WebhookEvent" ADD COLUMN "attemptCount" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "WebhookEvent" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "WebhookEvent" ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

ALTER TYPE "InventoryStatus" ADD VALUE 'QUARANTINED';
ALTER TABLE "EsimInventory" ADD COLUMN "lastProviderCheckedAt" TIMESTAMP(3);
ALTER TABLE "EsimInventory" ADD COLUMN "providerCheckError" STRING;
