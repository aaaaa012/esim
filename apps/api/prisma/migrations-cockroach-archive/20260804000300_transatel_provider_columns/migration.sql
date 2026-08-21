-- AlterTable
ALTER TABLE "EsimInventory" ADD COLUMN "providerSubscriptionId" STRING,
    ADD COLUMN "providerStatus" STRING,
    ADD COLUMN "activatedAt" TIMESTAMP(3),
    ADD COLUMN "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "providerSubscriptionId" STRING,
    ADD COLUMN "providerStatus" STRING;
