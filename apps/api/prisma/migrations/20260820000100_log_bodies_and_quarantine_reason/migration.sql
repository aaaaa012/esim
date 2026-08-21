ALTER TABLE "EsimInventory" ADD COLUMN "quarantineReason" STRING;
ALTER TABLE "IntegrationLog" ADD COLUMN "requestBody" JSONB;
ALTER TABLE "IntegrationLog" ADD COLUMN "responseBody" JSONB;