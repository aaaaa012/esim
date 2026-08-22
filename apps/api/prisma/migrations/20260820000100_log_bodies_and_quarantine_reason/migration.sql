ALTER TABLE "EsimInventory" ADD COLUMN "quarantineReason" TEXT;
ALTER TABLE "IntegrationLog" ADD COLUMN "requestBody" JSONB;
ALTER TABLE "IntegrationLog" ADD COLUMN "responseBody" JSONB;