-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'QR_READY';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "qrDeliveredAt" TIMESTAMP(3),
ADD COLUMN "activatedAt" TIMESTAMP(3);