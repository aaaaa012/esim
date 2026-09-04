ALTER TABLE "Order" ADD COLUMN "purchasedByUserId" UUID, ADD COLUMN "targetInventoryId" UUID, ADD COLUMN "checkoutAttemptKey" TEXT, ADD COLUMN "checkoutRequestHash" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_purchasedByUserId_fkey" FOREIGN KEY ("purchasedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_targetInventoryId_fkey" FOREIGN KEY ("targetInventoryId") REFERENCES "EsimInventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Order_checkoutAttemptKey_key" ON "Order"("checkoutAttemptKey");
CREATE INDEX "Order_purchasedByUserId_createdAt_idx" ON "Order"("purchasedByUserId", "createdAt");
CREATE INDEX "Order_targetInventoryId_idx" ON "Order"("targetInventoryId");
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT, ADD COLUMN "recoveryUrlEncrypted" TEXT;
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
