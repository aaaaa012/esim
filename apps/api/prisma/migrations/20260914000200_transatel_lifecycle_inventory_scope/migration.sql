ALTER TABLE "TransatelLifecycleOperation"
ADD COLUMN "inventoryId" UUID;

UPDATE "TransatelLifecycleOperation" AS lifecycle
SET "inventoryId" = COALESCE(
  orders."targetInventoryId",
  assigned_inventory."id",
  customer_esim."inventoryId"
)
FROM "Order" AS orders
LEFT JOIN "EsimInventory" AS assigned_inventory
  ON assigned_inventory."assignedOrderId" = orders."id"
LEFT JOIN "CustomerEsim" AS customer_esim
  ON customer_esim."orderId" = orders."id"
WHERE lifecycle."orderId" = orders."id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "TransatelLifecycleOperation" WHERE "inventoryId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Unable to resolve inventory for an existing Transatel lifecycle operation';
  END IF;
END $$;

ALTER TABLE "TransatelLifecycleOperation"
ALTER COLUMN "inventoryId" SET NOT NULL;

ALTER TABLE "TransatelLifecycleOperation"
ADD CONSTRAINT "TransatelLifecycleOperation_inventoryId_fkey"
FOREIGN KEY ("inventoryId") REFERENCES "EsimInventory"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "TransatelLifecycleOperation_one_active_per_order_key";

WITH ranked_active AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "inventoryId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS position
  FROM "TransatelLifecycleOperation"
  WHERE "state" IN (
    'APPROVAL_REQUIRED',
    'CREATED',
    'SUBMITTING',
    'ACCEPTED',
    'RECONCILE_REQUIRED'
  )
)
UPDATE "TransatelLifecycleOperation" AS lifecycle
SET
  "state" = 'REJECTED',
  "errorMessage" = COALESCE(
    lifecycle."errorMessage",
    'Superseded while lifecycle locking was migrated from order to eSIM scope'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM ranked_active
WHERE lifecycle."id" = ranked_active."id"
  AND ranked_active.position > 1;

CREATE UNIQUE INDEX "TransatelLifecycleOperation_one_active_per_inventory_key"
ON "TransatelLifecycleOperation"("inventoryId")
WHERE "state" IN (
  'APPROVAL_REQUIRED',
  'CREATED',
  'SUBMITTING',
  'ACCEPTED',
  'RECONCILE_REQUIRED'
);

CREATE INDEX "TransatelLifecycleOperation_inventoryId_createdAt_idx"
ON "TransatelLifecycleOperation"("inventoryId", "createdAt");
