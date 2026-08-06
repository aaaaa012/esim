-- Introduce an explicit approval gateway for SIM-profile uploads.
--
-- Previously every upload row was made AVAILABLE the moment the batch was
-- created. Now batches start PENDING and their rows stay in the IMPORTED
-- state until a Super Admin approves the batch (rows flip to AVAILABLE) or
-- rejects it (rows are withheld). Only AVAILABLE rows are eligible for FIFO
-- reservation, so nothing enters the sellable pool without approval.

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "InventoryBatch" ADD COLUMN "status" "BatchStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "InventoryBatch" ADD COLUMN "submittedById" UUID;
ALTER TABLE "InventoryBatch" ADD COLUMN "approvedById" UUID;
ALTER TABLE "InventoryBatch" ADD COLUMN "rejectedById" UUID;
ALTER TABLE "InventoryBatch" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "InventoryBatch" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "InventoryBatch" ADD COLUMN "rejectionReason" TEXT;