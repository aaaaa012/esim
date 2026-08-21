-- Retry/recovery state must survive a process restart and be visible to every
-- API replica. These fields replace process-local Maps in the order workflow.
ALTER TABLE "Order" ADD COLUMN "activationRefetchAttempts" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "lastProvisioningRecoveryAt" TIMESTAMPTZ;
ALTER TABLE "Payment" ADD COLUMN "verificationAttempts" INT4 NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "lastVerifiedAt" TIMESTAMPTZ;

CREATE INDEX "Order_lastProvisioningRecoveryAt_idx" ON "Order"("lastProvisioningRecoveryAt");
CREATE INDEX "Payment_verificationAttempts_lastVerifiedAt_idx" ON "Payment"("verificationAttempts", "lastVerifiedAt");
