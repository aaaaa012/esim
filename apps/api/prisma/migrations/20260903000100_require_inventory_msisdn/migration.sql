-- Top-ups are addressed by the provider-assigned eSIM MSISDN. Inventory
-- without an MSISDN cannot be provisioned or recharged.
ALTER TABLE "EsimInventory"
ALTER COLUMN "msisdn" SET NOT NULL;
