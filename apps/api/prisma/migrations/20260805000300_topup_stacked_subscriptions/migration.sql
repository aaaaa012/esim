-- Drop the one-to-one constraint that prevented multiple top-up orders from
-- referencing the same physical eSIM (ICCID). A single eSIM can now host
-- several stacked subscriptions, one per order, each with its own expiry.
-- AlterTable
DROP CONSTRAINT IF EXISTS "CustomerEsim_inventoryId_key";

CREATE INDEX "CustomerEsim_inventoryId_idx" ON "CustomerEsim"("inventoryId");
