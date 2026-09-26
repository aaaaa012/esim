-- Existing orders retain the old policy; future orders use version 1.
ALTER TABLE "Order" ADD COLUMN "contactRuleVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ALTER COLUMN "contactRuleVersion" SET DEFAULT 1;

ALTER TABLE "Traveler" ADD COLUMN "contactNumberNormalized" TEXT;
UPDATE "Traveler" AS traveler
SET "contactNumberNormalized" = CASE
    WHEN numbers.digits ~ '^9[0-9]{9}$' THEN '977' || numbers.digits
    WHEN numbers.digits ~ '^9779[0-9]{9}$' THEN numbers.digits
    WHEN numbers.digits ~ '^009779[0-9]{9}$' THEN substring(numbers.digits FROM 3)
    ELSE NULL
END
FROM (
    SELECT id, regexp_replace(mobile, '[^0-9]', '', 'g') AS digits
    FROM "Traveler"
) AS numbers
WHERE traveler.id = numbers.id;
CREATE INDEX "Traveler_contactNumberNormalized_idx" ON "Traveler"("contactNumberNormalized");

CREATE TABLE "EsimContactClaim" (
    "contactNumber" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "customerId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EsimContactClaim_pkey" PRIMARY KEY ("contactNumber")
);

CREATE UNIQUE INDEX "EsimContactClaim_orderId_key" ON "EsimContactClaim"("orderId");
CREATE UNIQUE INDEX "EsimContactClaim_customerId_key" ON "EsimContactClaim"("customerId");
ALTER TABLE "EsimContactClaim" ADD CONSTRAINT "EsimContactClaim_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
