-- Order channel (source of the sale) + Partner integration type (how the
-- agency integrates). Distinguishes the three order origins for
-- reconciliation: own customer web, agency REST API, agency hosted checkout
-- link.

-- CreateEnum
CREATE TYPE IF NOT EXISTS "OrderChannel" AS ENUM ('CUSTOMER_WEB', 'PARTNER_API', 'PARTNER_HOSTED');

-- CreateEnum
CREATE TYPE IF NOT EXISTS "PartnerIntegrationType" AS ENUM ('API', 'CHECKOUT_LINK');

-- AlterTable
ALTER TABLE "Order" SET (schema_locked = false);
ALTER TABLE "Order" ADD COLUMN     "channel" "OrderChannel";

-- Backfill existing orders by origin before making the column required.
-- Hosted sessions prove the order arrived via a checkout link; a partnerId
-- without a hosted session came through the REST API; everything else is
-- our own customer web.
UPDATE "Order" o
  SET "channel" = 'PARTNER_HOSTED'
  WHERE EXISTS (
    SELECT 1 FROM "PartnerHostedCheckoutSession" s
    WHERE s."orderId" = o."id"
  );
UPDATE "Order" o
  SET "channel" = 'PARTNER_API'
  WHERE "channel" IS NULL AND "partnerId" IS NOT NULL;
UPDATE "Order"
  SET "channel" = 'CUSTOMER_WEB'
  WHERE "channel" IS NULL;
ALTER TABLE "Order" ALTER COLUMN "channel" SET NOT NULL;

-- AlterTable
ALTER TABLE "Partner" SET (schema_locked = false);
ALTER TABLE "Partner" ADD COLUMN     "integrationType" "PartnerIntegrationType" DEFAULT 'API';
ALTER TABLE "Partner" ALTER COLUMN "integrationType" SET NOT NULL;
