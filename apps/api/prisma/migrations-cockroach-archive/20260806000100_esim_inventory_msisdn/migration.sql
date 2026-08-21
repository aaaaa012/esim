-- Store the MSISDN associated with each eSIM as delivered in the Transatel
-- SIM delivery file. The Transatel OCS subscription API binds orders via
-- bind.msisdn (the SIM's phone number, without the leading '+'), so the
-- number must be captured on the inventory row instead of reusing the ICCID.
-- AlterTable
ALTER TABLE "EsimInventory" ADD COLUMN "msisdn" TEXT;

-- Each ICCID has exactly one MSISDN.
CREATE UNIQUE INDEX "EsimInventory_msisdn_key" ON "EsimInventory"("msisdn");
