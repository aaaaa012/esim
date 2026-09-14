ALTER TABLE "PartnerEvent" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "PartnerEvent_dedupeKey_key" ON "PartnerEvent"("dedupeKey");
