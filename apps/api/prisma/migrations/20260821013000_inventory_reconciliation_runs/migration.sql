CREATE TABLE "InventoryReconciliationRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "trigger" STRING NOT NULL,
  "status" STRING NOT NULL DEFAULT 'QUEUED',
  "selection" STRING NOT NULL,
  "batchId" UUID,
  "requestedById" UUID,
  "total" INT4 NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "InventoryReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryReconciliationItem" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "inventoryId" UUID NOT NULL,
  "status" STRING NOT NULL DEFAULT 'QUEUED',
  "error" STRING,
  "checkedAt" TIMESTAMP(3),
  CONSTRAINT "InventoryReconciliationItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryReconciliationRun_status_createdAt_idx"
  ON "InventoryReconciliationRun"("status", "createdAt");
CREATE INDEX "InventoryReconciliationRun_batchId_idx"
  ON "InventoryReconciliationRun"("batchId");
CREATE UNIQUE INDEX "InventoryReconciliationItem_runId_inventoryId_key"
  ON "InventoryReconciliationItem"("runId", "inventoryId");
CREATE INDEX "InventoryReconciliationItem_runId_status_idx"
  ON "InventoryReconciliationItem"("runId", "status");
CREATE INDEX "InventoryReconciliationItem_inventoryId_idx"
  ON "InventoryReconciliationItem"("inventoryId");

ALTER TABLE "InventoryReconciliationRun"
  ADD CONSTRAINT "InventoryReconciliationRun_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "InventoryBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryReconciliationItem"
  ADD CONSTRAINT "InventoryReconciliationItem_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "InventoryReconciliationRun"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryReconciliationItem"
  ADD CONSTRAINT "InventoryReconciliationItem_inventoryId_fkey"
  FOREIGN KEY ("inventoryId") REFERENCES "EsimInventory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
