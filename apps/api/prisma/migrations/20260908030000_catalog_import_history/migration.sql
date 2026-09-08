CREATE TYPE "CatalogImportStatus" AS ENUM ('APPLIED', 'FAILED');
CREATE TYPE "CatalogImportRowChange" AS ENUM ('NEW', 'UPDATED', 'UNCHANGED', 'MISSING', 'RETURNED', 'INVALID');

ALTER TABLE "Plan"
  ADD COLUMN "lastCatalogSeenAt" TIMESTAMP(3),
  ADD COLUMN "providerMissingSince" TIMESTAMP(3);

CREATE TABLE "CatalogImportBatch" (
  "id" UUID NOT NULL,
  "batchReference" TEXT NOT NULL,
  "fileName" TEXT,
  "contentHash" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" "CatalogImportStatus" NOT NULL DEFAULT 'APPLIED',
  "uploadedById" UUID,
  "totalRows" INTEGER NOT NULL,
  "newCount" INTEGER NOT NULL DEFAULT 0,
  "updatedCount" INTEGER NOT NULL DEFAULT 0,
  "unchangedCount" INTEGER NOT NULL DEFAULT 0,
  "missingCount" INTEGER NOT NULL DEFAULT 0,
  "returnedCount" INTEGER NOT NULL DEFAULT 0,
  "invalidCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CatalogImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogImportRow" (
  "id" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "planId" UUID,
  "countryIso2" TEXT NOT NULL,
  "providerPlanId" TEXT NOT NULL,
  "change" "CatalogImportRowChange" NOT NULL,
  "previousValue" JSONB,
  "proposedValue" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CatalogImportRow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogImportBatch_batchReference_key" ON "CatalogImportBatch"("batchReference");
CREATE INDEX "CatalogImportBatch_createdAt_idx" ON "CatalogImportBatch"("createdAt");
CREATE INDEX "CatalogImportRow_batchId_change_idx" ON "CatalogImportRow"("batchId", "change");
CREATE INDEX "CatalogImportRow_countryIso2_providerPlanId_idx" ON "CatalogImportRow"("countryIso2", "providerPlanId");
ALTER TABLE "CatalogImportRow" ADD CONSTRAINT "CatalogImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CatalogImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
